import type Transcode from '#transcodes/models/transcode'
import { PipelineFirehose } from '#transcodes/services/pipeline_firehose'
import TranscodeTransformer from '#transcodes/transformers/transcode_transformer'
import { inject } from '@adonisjs/core'
import logger from '@adonisjs/core/services/logger'
import transmit from '@adonisjs/transmit/services/main'

/**
 * Pushes the unified Transcode wire payload to SSE subscribers in real time
 * (jalon F, #6) on the per-resource channel `transcodes/<id>`.
 *
 * The payload is built through `TranscodeTransformer` — the exact shape the
 * status poll serves (`id, status, progress, outputPlaylist, error`, plus
 * `radioTrack` on the `radio` profile at COMPLETED) — so a live client and a
 * polling client see one contract.
 *
 * L'événement du **firehose** d'ops porte la même sortie, et **sans redire la
 * règle** : il recopie le champ que le transformateur a déjà décidé de publier ou
 * non. Une page d'ops qui ne verrait que `outputPlaylist: null` présenterait
 * chaque radio réussie comme « terminée sans média » — une fausse alerte
 * récurrente, qui apprend à ignorer les vraies (ADR-0010).
 *
 * Broadcasting is routed through Transmit's Redis transport (config/transmit.ts)
 * so a push from the worker process reaches SSE clients on the HTTP server.
 * Best-effort, mirroring `ProgressStore`: a transport hiccup must never fail an
 * encode, so it is caught and logged rather than thrown.
 *
 * In addition to the per-resource SSE push, the same event is fanned out on the
 * raw `pipeline:events` Redis channel (the ops observability firehose) — also
 * best-effort, so neither transport can fail an encode.
 */
@inject()
export class TranscodePublisher {
  constructor(private firehose: PipelineFirehose) {}

  broadcast(transcode: Transcode, liveProgress?: number | null): void {
    const payload = new TranscodeTransformer(transcode, liveProgress).toObject()
    try {
      transmit.broadcast(`transcodes/${payload.id}`, payload)
    } catch (error) {
      logger.error({ err: error, transcodeId: payload.id }, 'transcode broadcast failed')
    }
    void this.firehose.publish({
      transcodeId: payload.id,
      status: payload.status,
      progress: payload.progress,
      error: payload.error,
      outputPlaylist: payload.outputPlaylist,
      // **Aucune garde ici, et c'est le point.** `COMPLETED` seulement, absent
      // hors du profil radio : ces deux règles vivent dans `TranscodeTransformer`
      // et l'événement se contente de relayer ce qu'elles ont laissé passer. Les
      // réécrire ici ferait deux jumelles qui finiraient par différer.
      ...(payload.radioTrack ? { radioTrack: payload.radioTrack } : {}),
    })
  }
}
