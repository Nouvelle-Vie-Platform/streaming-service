import Transcode from '#transcodes/models/transcode'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { ProgressStore } from '#transcodes/services/progress_store'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { WebhookQueue } from '#transcodes/queues/webhook_queue'
import { ArchiveQueue } from '#transcodes/queues/archive_queue'
import { NoAudioTrackException } from '#transcodes/exceptions/no_audio_track_exception'
import {
  downloadKeyPrefix,
  downloadOutputDir,
  downloadRenditionUrl,
  hlsKeyPrefix,
  hlsOutputDir,
  masterPlaylistPath,
  outputPlaylistUrl,
} from '#transcodes/support/hls'
import type { DownloadRenditionInfo } from '#transcodes/support/hls'
import { PhaseTimings } from '#transcodes/support/phase_timing'
import { inject } from '@adonisjs/core'
import { existsSync } from 'node:fs'

export interface ProcessTranscodeParams {
  id: string
  /** ffmpeg input: a local Source path (upload) or a remote URL (URL ingestion). */
  source: string
  /** true = URL source: ffmpeg reads the URL, no FLAC archive is produced. */
  remote: boolean
}

/**
 * The outcome of a completed pass, returned so the caller wires nothing by hand:
 * the playlist URL plus the three download renditions — each carrying its
 * absolute public URL and byte size (`DownloadRenditionInfo`, ADR-0009), the
 * same shape persisted on the row and pushed in the completion webhook.
 */
export interface ProcessTranscodeResult {
  id: string
  outputPlaylist: string
  downloads: DownloadRenditionInfo[]
}

/**
 * Drives one Transcode from PENDING to COMPLETED (see CONTEXT.md, ADR-0004).
 *
 * The only layer that touches the model, and the single place the lifecycle
 * transitions live. Steps: probe (reject a source with no audio as a permanent
 * failure), mark PROCESSING, run the single ffmpeg pass while streaming the
 * percentage to Redis, then mark COMPLETED with the playlist URL and duration.
 *
 * COMPLETED means **"servable from RustFS"** (ADR-0004, Q18): the local HLS is
 * pushed to RustFS before the transition, and only then is the row marked done.
 * Idempotent with a checkpoint — on a retry where the HLS is already on disk it
 * skips ffmpeg and just re-pushes and finalizes, so a RustFS hiccup never
 * re-spends the CPU. Archiving the FLAC and reclaiming local disk is the
 * separate second job (ArchiveTranscode), enqueued once COMPLETED.
 */
@inject()
export class ProcessTranscode {
  constructor(
    private transcoder: FfmpegTranscoder,
    private progressStore: ProgressStore,
    private publisher: TranscodePublisher,
    private webhookQueue: WebhookQueue,
    private rustfs: RustfsStorage,
    private archiveQueue: ArchiveQueue
  ) {}

  async execute(params: ProcessTranscodeParams): Promise<ProcessTranscodeResult> {
    const transcode = await Transcode.findOrFail(params.id)

    // Quatre étapes de natures très différentes — une sonde, un encodage, deux
    // envois réseau qui font un aller-retour **par fichier** — et rien ne disait
    // laquelle durait. Voir `PhaseTimings` : on mesure avant d'optimiser.
    const timings = new PhaseTimings()

    let downloads: { name: string; bytes: number }[]
    if (!existsSync(masterPlaylistPath(params.id))) {
      const probe = await timings.time('probe', () => this.transcoder.probe(params.source))
      if (!probe.hasAudio) {
        throw new NoAudioTrackException()
      }

      transcode.status = 'PROCESSING'
      transcode.durationSeconds = probe.durationSeconds
      await transcode.save()
      await this.progressStore.set(params.id, 0)
      this.publisher.broadcast(transcode, 0)

      let lastPercent = 0
      const result = await timings.time('encode', () =>
        this.transcoder.encode(
          params.source,
          params.id,
          probe.durationSeconds,
          (percent) => {
            if (percent > lastPercent) {
              lastPercent = percent
              // Best-effort: a Redis hiccup must not fail the encode.
              void this.progressStore.set(params.id, percent).catch(() => {})
              this.publisher.broadcast(transcode, percent)
            }
          },
          // A URL source keeps no FLAC archive — the original lives at the URL.
          // The `.aac` download renditions are produced on both paths (ADR-0009).
          { withArchive: !params.remote }
        )
      )
      downloads = result.downloads
    } else {
      // Checkpoint retry: the pass already staged the `.aac` alongside the HLS —
      // recover their sizes without re-encoding (ADR-0009).
      downloads = await this.transcoder.measureDownloads(params.id)
    }

    // Push the HLS *and* the download renditions to RustFS *before* COMPLETED —
    // the client must be able to play/download from the serving origin the moment
    // we say it's ready (Q18). The `.aac` ride their own `dl/<id>/` prefix.
    await timings.count('uploadHls', () =>
      this.rustfs.uploadDirectory(hlsOutputDir(params.id), hlsKeyPrefix(params.id))
    )
    await timings.count('uploadDownloads', () =>
      this.rustfs.uploadDirectory(downloadOutputDir(params.id), downloadKeyPrefix(params.id))
    )

    // Pair each measured byte size with its absolute public URL — the single
    // shape the row, the webhook and the returned result all carry (ADR-0009).
    const renditions: DownloadRenditionInfo[] = downloads.map((rendition) => ({
      name: rendition.name,
      url: downloadRenditionUrl(params.id, rendition.name),
      bytes: rendition.bytes,
    }))

    transcode.status = 'COMPLETED'
    transcode.outputPlaylist = outputPlaylistUrl(params.id)
    // Persist the download renditions alongside the playlist so the row is
    // self-describing — the client (#187) gets URLs + sizes without a HEAD.
    transcode.downloads = renditions
    await transcode.save()
    await this.progressStore.set(params.id, 100)
    this.publisher.broadcast(transcode, 100)

    // Completion webhook (jalon I): notify the caller URL, if any, of the
    // terminal COMPLETED state via a dedicated retrying delivery job.
    if (transcode.callbackUrl) {
      await this.webhookQueue.enqueue({
        transcodeId: transcode.id,
        callbackUrl: transcode.callbackUrl,
        callbackSecret: transcode.callbackSecret ?? undefined,
        payload: {
          id: transcode.id,
          status: transcode.status,
          progress: 100,
          outputPlaylist: transcode.outputPlaylist,
          error: null,
          // ADR-0009: the completion payload carries the duration and, per
          // rendition, the download URL + byte size — so the consumer (#187)
          // persists and serves them without a HEAD per file.
          durationSeconds: transcode.durationSeconds,
          downloads: renditions,
        },
      })
    }

    // Second stage (ADR-0004): archive the FLAC (uploads only) and reclaim local
    // disk. A separate job so a RustFS outage retries without re-encoding.
    await this.archiveQueue.enqueue({
      id: params.id,
      source: params.source,
      remote: params.remote,
    })

    // **La mesure est posée ici et pas plus tôt** : après l'archive mise en file,
    // avant le retour. Plus haut, elle raterait la fin ; dans un `finally`, elle
    // sortirait aussi sur un échec — et une ligne « terminé » sur un transcodage
    // qui a échoué est exactement le genre de journal qui trompe à 3 h du matin.
    timings.log(params.id)

    // The download renditions are now on the public origin: hand the caller (#186)
    // each rendition's absolute URL + byte size so it can persist and publish them.
    return {
      id: params.id,
      outputPlaylist: transcode.outputPlaylist,
      downloads: renditions,
    }
  }
}
