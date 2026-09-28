import { queueConnection } from '#config/queue'
import { withdrawJob } from '#transcodes/support/withdraw_job'
import { Queue } from 'bullmq'

/** Second-stage queue: archive the FLAC and reclaim local disk (ADR-0004). */
export const ARCHIVE_QUEUE = 'archive'

export interface ArchiveJobData {
  id: string
  /** The transcode source (local path or remote URL). */
  source: string
  /** true = URL source: no local Source to delete, no FLAC to archive. */
  remote: boolean
}

/**
 * Producer of the archive/cleanup job. Enqueued by the transcode job **after**
 * COMPLETED, so a RustFS outage here retries independently and never re-encodes
 * *the HLS* (Q18). `jobId = id` keeps it idempotent.
 *
 * ⚠️ **Ce job encode désormais le FLAC lui-même** : il a quitté la passe
 * principale, qui n'a plus à attendre un fichier de conservation pour déclarer
 * l'enseignement écoutable. Un rejeu après un envoi refusé ne le ré-encode pas
 * (le fichier est encore là) ; un rejeu après un échec d'encodage, si.
 */
export class ArchiveQueue {
  private queue = new Queue<ArchiveJobData>(ARCHIVE_QUEUE, { connection: queueConnection })

  async enqueue(data: ArchiveJobData): Promise<void> {
    await this.queue.add('archive', data, {
      jobId: data.id,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    })
  }

  /**
   * Takes a pending archive job off the queue before deleting the Transcode
   * (ADR-0008). Without this, a job that fires after the deletion would push a
   * FLAC into a bucket nobody owns any more — bytes with no row, the very leak
   * this route exists to stop. `false` = the archive job is running right now.
   */
  async withdraw(id: string): Promise<boolean> {
    return withdrawJob(this.queue, id)
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}
