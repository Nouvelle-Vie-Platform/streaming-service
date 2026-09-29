import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import logger from '@adonisjs/core/services/logger'
import { ProcessTranscode } from '#transcodes/actions/process_transcode'
import { FailTranscode } from '#transcodes/actions/fail_transcode'
import { ArchiveTranscode } from '#transcodes/actions/archive_transcode'
import { NoAudioTrackException } from '#transcodes/exceptions/no_audio_track_exception'
import { queueConnection, workerConcurrency } from '#config/queue'
import { TRANSCODE_QUEUE, type TranscodeJobData } from '#transcodes/queues/transcode_queue'
import { WEBHOOK_QUEUE, type WebhookJobData } from '#transcodes/queues/webhook_queue'
import { ARCHIVE_QUEUE, type ArchiveJobData } from '#transcodes/queues/archive_queue'
import { deliverWebhook } from '#transcodes/support/deliver_webhook'
import { UnrecoverableError, Worker } from 'bullmq'

/**
 * `node ace transcode:work` — the long-running worker (jalons D/E).
 *
 * Pulls transcode jobs off the queue and runs the encode via `ProcessTranscode`.
 * Failure handling (Q9):
 * - a **permanent** failure (no audio track) is re-thrown as `UnrecoverableError`
 *   so BullMQ does not retry it;
 * - a **transient** failure bubbles up and BullMQ retries it with backoff.
 *
 * The Transcode is marked FAILED once — in the `failed` listener — only when the
 * job is truly terminal (unrecoverable, or retries exhausted). Drained cleanly
 * on SIGTERM.
 */
export default class TranscodeWorker extends BaseCommand {
  static commandName = 'transcode:work'
  static description = 'Run the transcode worker: consume queued jobs and encode audio HLS'
  static options: CommandOptions = { startApp: true, staysAlive: true }

  async run() {
    const processTranscode = await this.app.container.make(ProcessTranscode)
    const failTranscode = await this.app.container.make(FailTranscode)
    const archiveTranscode = await this.app.container.make(ArchiveTranscode)

    const worker = new Worker<TranscodeJobData>(
      TRANSCODE_QUEUE,
      async (job) => {
        logger.info({ jobId: job.id }, 'transcode started')
        try {
          await processTranscode.execute({
            id: job.data.id,
            source: job.data.source,
            remote: job.data.remote,
            // Absent sur un job enfilé par la version précédente : l'action
            // retombe alors sur le régime des enseignements (issue #46).
            profile: job.data.profile,
          })
        } catch (error) {
          if (error instanceof NoAudioTrackException) {
            throw new UnrecoverableError(error.message)
          }
          throw error
        }
        logger.info({ jobId: job.id }, 'transcode completed')
      },
      { connection: queueConnection, concurrency: workerConcurrency }
    )

    worker.on('failed', async (job, error) => {
      logger.error({ err: error, jobId: job?.id }, 'transcode job failed')
      if (!job) return

      const attempts = job.opts.attempts ?? 1
      const terminal = error instanceof UnrecoverableError || job.attemptsMade >= attempts
      if (terminal) {
        await failTranscode
          .execute({
            id: job.data.id,
            reason: error.message,
            source: job.data.source,
            remote: job.data.remote,
          })
          .catch((markError) =>
            logger.error({ err: markError, jobId: job.id }, 'mark FAILED failed')
          )
      }
    })

    // Completion-webhook delivery (jalon I). A second Worker in the same process
    // drains the `webhook` queue: it POSTs the terminal-state payload to the
    // caller URL, and a non-2xx / timeout throws so BullMQ retries with backoff.
    const webhookWorker = new Worker<WebhookJobData>(
      WEBHOOK_QUEUE,
      async (job) => {
        logger.info({ jobId: job.id, transcodeId: job.data.transcodeId }, 'webhook started')
        await deliverWebhook(job.data)
        logger.info({ jobId: job.id, transcodeId: job.data.transcodeId }, 'webhook delivered')
      },
      { connection: queueConnection, concurrency: workerConcurrency }
    )

    webhookWorker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id }, 'webhook delivery failed')
    })

    // Archive/cleanup (jalon G, ADR-0004). A third Worker drains the `archive`
    // queue: push the FLAC to RustFS, record its key, then delete the local HLS
    // staging and the Source. Retries independently of the encode.
    const archiveWorker = new Worker<ArchiveJobData>(
      ARCHIVE_QUEUE,
      async (job) => {
        logger.info({ jobId: job.id }, 'archive started')
        await archiveTranscode.execute({
          id: job.data.id,
          source: job.data.source,
          remote: job.data.remote,
          profile: job.data.profile,
        })
        logger.info({ jobId: job.id }, 'archive completed')
      },
      { connection: queueConnection, concurrency: workerConcurrency }
    )

    archiveWorker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id }, 'archive job failed')
    })

    logger.info(`transcode worker ready (concurrency=${workerConcurrency})`)

    this.app.terminating(async () => {
      await worker.close()
      await webhookWorker.close()
      await archiveWorker.close()
    })
  }
}
