import type { SourceKind, TranscodeProfile } from '#transcodes/support/transcode_enums'
import { queueConnection } from '#config/queue'
import { withdrawJob } from '#transcodes/support/withdraw_job'
import { Queue } from 'bullmq'

/** The single BullMQ queue name; the worker binds to the same string. */
export const TRANSCODE_QUEUE = 'transcode'

/**
 * Everything the worker needs to process a Transcode without re-reading the DB.
 * `source` is the ffmpeg input — a local path for an upload, or a remote URL for
 * a URL ingestion; `remote` tells the worker whether there is a local Source to
 * clean up and a FLAC archive to produce.
 */
export interface TranscodeJobData {
  id: string
  source: string
  sourceKind: SourceKind
  remote: boolean
  /**
   * Le profil demandé (issue #46) — ce qu'il faut fabriquer.
   *
   * **Facultatif exprès.** Un job déjà en file au moment d'une bascule
   * blue/green a été écrit par la version précédente et ne porte pas ce champ ;
   * le worker doit le traiter comme un enseignement, pas planter dessus. Le
   * défaut est donc relu à la lecture (`DEFAULT_PROFILE`), et la ligne en base
   * porte de son côté le même défaut, posé par Postgres.
   */
  profile?: TranscodeProfile
}

/**
 * Producer side of the transcode queue — the only thing the HTTP path touches.
 * A singleton (see `providers/queue_provider.ts`) so its Redis connection is
 * opened once and closed on shutdown.
 */
export class TranscodeQueue {
  private queue = new Queue<TranscodeJobData>(TRANSCODE_QUEUE, { connection: queueConnection })

  /**
   * Enqueues a transcode job. The job id **is** the Transcode id (ADR-0002),
   * so re-submitting the same upload is idempotent — BullMQ drops a duplicate
   * jobId rather than transcoding twice.
   */
  async enqueue(data: TranscodeJobData): Promise<void> {
    await this.queue.add('transcode', data, {
      jobId: data.id,
      // Transient failures (OOM, I/O) retry with backoff; a permanent failure
      // (no audio track) is thrown as unrecoverable and skips these (Q9).
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    })
  }

  /**
   * Takes a queued transcode back off the queue before deleting it (ADR-0008).
   * `false` means a worker is encoding it right now — the deletion is refused,
   * not forced. `jobId = id` is what makes this addressable at all.
   */
  async withdraw(id: string): Promise<boolean> {
    return withdrawJob(this.queue, id)
  }

  /**
   * Read-only snapshot of the queue for the ops observability plane. The queue,
   * not the `status` column, is the live truth about what is waiting/running
   * (ADR-0008), so counts and active jobs are read straight from BullMQ.
   */
  async jobCounts(): Promise<{ waiting: number; active: number; failed: number }> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'failed')
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
    }
  }

  /** The jobs a worker holds right now, with their live progress and start time. */
  async activeJobs(): Promise<
    { transcodeId: string; progress: number; startedAt: string; status: string }[]
  > {
    const jobs = await this.queue.getActive()
    return jobs.map((job) => ({
      transcodeId: String(job.id),
      progress: typeof job.progress === 'number' ? job.progress : 0,
      startedAt: new Date(job.processedOn ?? job.timestamp).toISOString(),
      status: 'PROCESSING',
    }))
  }

  /** The most recent failed jobs, newest first, for the ops failure feed. */
  async recentFailures(
    limit = 10
  ): Promise<{ transcodeId: string; error: string | null; at: string }[]> {
    const jobs = await this.queue.getFailed(0, limit - 1)
    return jobs.map((job) => ({
      transcodeId: String(job.id),
      error: job.failedReason ?? null,
      at: new Date(job.finishedOn ?? job.timestamp).toISOString(),
    }))
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}
