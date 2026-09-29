import type { RadioTrackInfo } from '#transcodes/support/hls'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import { Redis } from 'ioredis'

/** Raw Redis pub/sub channel the pipeline observability plane listens on. */
export const PIPELINE_EVENTS_CHANNEL = 'pipeline:events'

/**
 * One raw firehose event — the lifecycle-relevant subset of the unified
 * Transcode contract, keyed by `transcodeId` so a downstream enricher can map
 * it back to its media deposit.
 */
export interface PipelineFirehoseEvent {
  transcodeId: string
  status: string
  progress: number | null
  error: string | null
  outputPlaylist: string | null
  /**
   * La sortie du profil `radio` (ADR-0010), aux mêmes conditions que dans le
   * contrat unifié : présente à `COMPLETED`, absente partout ailleurs.
   *
   * ⚠️ **Une page d'ops n'a pas le droit de mentir, même sans perdre de donnée.**
   * Sur ce profil, `outputPlaylist` vaut `null` par construction : sans ce champ,
   * chaque radio réussie s'afficherait « terminée sans média », c'est-à-dire en
   * panne. La plateforme a une doctrine explicite là-dessus — **un indicateur qui
   * montre zéro apprend à être ignoré** —, et une fausse alerte récurrente est
   * pire qu'un silence : elle finit par faire ignorer les vraies. Ce dépôt a déjà
   * payé ce prix avec une sonde durablement rouge qui ne signalait plus rien.
   *
   * La condition n'est **pas** réécrite ici : l'événement recopie ce que le
   * contrat unifié a déjà tranché (voir `TranscodePublisher`). Deux règles
   * identiques écrites à deux endroits divergent.
   */
  radioTrack?: RadioTrackInfo
}

/**
 * Publishes raw Transcode lifecycle events on a Redis pub/sub channel
 * (`pipeline:events`) for the ops observability plane — a firehose that is
 * *in addition to* the per-resource Transmit SSE channel.
 *
 * It opens its own lazy ioredis client on the same Redis the BullMQ queue uses
 * (the `REDIS_*` env, config/queue.ts). Strictly best-effort: a Redis hiccup is
 * caught and logged, never thrown, so it can never fail an encode.
 */
export class PipelineFirehose {
  private client?: Redis

  private connection(): Redis {
    if (!this.client) {
      this.client = new Redis({
        host: env.get('REDIS_HOST'),
        port: env.get('REDIS_PORT'),
        password: env.get('REDIS_PASSWORD') || undefined,
        // Fire-and-forget publisher: don't retry forever if Redis is unreachable.
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      })
    }
    return this.client
  }

  async publish(event: PipelineFirehoseEvent): Promise<void> {
    try {
      await this.connection().publish(PIPELINE_EVENTS_CHANNEL, JSON.stringify(event))
    } catch (error) {
      logger.error(
        { err: error, transcodeId: event.transcodeId },
        'pipeline firehose publish failed'
      )
    }
  }
}
