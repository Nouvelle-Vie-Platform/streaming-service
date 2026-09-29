import Transcode from '#transcodes/models/transcode'
import { ProgressStore } from '#transcodes/services/progress_store'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import { WebhookQueue } from '#transcodes/queues/webhook_queue'
import { downloadOutputDir, hlsOutputDir, radioOutputDir } from '#transcodes/support/hls'
import { inject } from '@adonisjs/core'
import { rm } from 'node:fs/promises'

export interface FailTranscodeParams {
  id: string
  reason: string
  /** The transcode source (local path or URL). */
  source?: string
  /** true = URL source: there is no local Source to delete. */
  remote?: boolean
}

/**
 * Marks a Transcode FAILED with its reason and drops the volatile progress.
 *
 * Called by the worker once a job is terminal — a permanent error, or a
 * transient one whose retries are exhausted (see the design, Q9). Idempotent
 * and forgiving: a missing row is a no-op.
 */
@inject()
export class FailTranscode {
  constructor(
    private progressStore: ProgressStore,
    private publisher: TranscodePublisher,
    private webhookQueue: WebhookQueue
  ) {}

  async execute(params: FailTranscodeParams): Promise<void> {
    const transcode = await Transcode.find(params.id)
    if (!transcode) return

    transcode.status = 'FAILED'
    transcode.error = params.reason
    await transcode.save()
    await this.progressStore.clear(params.id)
    this.publisher.broadcast(transcode)

    // Completion webhook (jalon I): notify the caller URL, if any, of the
    // terminal FAILED state via a dedicated retrying delivery job.
    if (transcode.callbackUrl) {
      await this.webhookQueue.enqueue({
        transcodeId: transcode.id,
        callbackUrl: transcode.callbackUrl,
        callbackSecret: transcode.callbackSecret ?? undefined,
        payload: {
          id: transcode.id,
          status: transcode.status,
          progress: null,
          outputPlaylist: transcode.outputPlaylist ?? null,
          error: transcode.error,
          // The unified shape holds on both terminal states (ADR-0005): a FAILED
          // transcode produced no renditions, so `downloads` is empty; the
          // duration is sent if the probe reached it before the failure.
          durationSeconds: transcode.durationSeconds ?? null,
          downloads: transcode.downloads ?? [],
        },
      })
    }

    // Reclaim disk: a failed Transcode has nothing worth archiving (ADR-0004).
    // Best-effort — remove any partial HLS staging, and the local Source unless
    // the source was a URL (nothing local to delete).
    if (!params.remote && params.source) await rm(params.source, { force: true })
    await rm(hlsOutputDir(params.id), { recursive: true, force: true })
    // Les deux autres staging partent aussi, sans condition de profil : un
    // encodage interrompu laisse un `.aac` tronqué ou une piste radio à moitié
    // écrite, et **la piste radio à moitié écrite est la plus dangereuse** — sa
    // présence est le point de reprise, donc une reprise la publierait telle
    // quelle au lieu de la refaire.
    await rm(downloadOutputDir(params.id), { recursive: true, force: true })
    await rm(radioOutputDir(params.id), { recursive: true, force: true })
  }
}
