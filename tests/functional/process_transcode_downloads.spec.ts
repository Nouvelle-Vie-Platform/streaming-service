import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Transcode from '#transcodes/models/transcode'
import { ProcessTranscode } from '#transcodes/actions/process_transcode'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { ProgressStore } from '#transcodes/services/progress_store'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { ArchiveQueue } from '#transcodes/queues/archive_queue'
import { WebhookQueue, type WebhookJobData } from '#transcodes/queues/webhook_queue'
import { RENDITIONS, downloadRenditionUrl } from '#transcodes/support/hls'

/** The byte sizes a stubbed encode "measures" per rung — arbitrary but distinct. */
const BYTES: Record<string, number> = { low: 1_000, mid: 2_000, high: 3_000 }

/** The duration the stubbed probe reports; must land on both the row and the webhook. */
const DURATION = 321.5

/** A stubbed encoder: no ffmpeg, just the shape ProcessTranscode consumes. */
function stubTranscoder() {
  const downloads = RENDITIONS.map((r) => ({
    name: r.name,
    bitrate: r.bitrate,
    bytes: BYTES[r.name],
  }))
  app.container.swap(FfmpegTranscoder, () => {
    return {
      probe: async () => ({ hasAudio: true, durationSeconds: DURATION }),
      encode: async () => ({ downloads }),
      measureDownloads: async () => downloads,
    } as unknown as FfmpegTranscoder
  })
}

/** Silences the side-effect collaborators so the test observes only persistence + webhook. */
function stubSideEffects() {
  app.container.swap(ProgressStore, () => {
    return { set: async () => {}, clear: async () => {} } as unknown as ProgressStore
  })
  app.container.swap(TranscodePublisher, () => {
    return { broadcast: () => {} } as unknown as TranscodePublisher
  })
  app.container.swap(RustfsStorage, () => {
    // Rend le **nombre de fichiers envoyés**, comme la vraie : c'est ce que la
    // mesure des phases journalise, et un double qui rendrait `undefined` ferait
    // passer un contrat que la production n'a pas.
    return { uploadDirectory: async () => 0 } as unknown as RustfsStorage
  })
  app.container.swap(ArchiveQueue, () => {
    return { enqueue: async () => {} } as unknown as ArchiveQueue
  })
}

/** Captures the completion webhook job instead of enqueuing it. */
function webhookSpy() {
  const jobs: WebhookJobData[] = []
  app.container.swap(WebhookQueue, () => {
    return {
      enqueue: async (data: WebhookJobData) => void jobs.push(data),
    } as unknown as WebhookQueue
  })
  return jobs
}

test.group('ProcessTranscode — download renditions at COMPLETED (ADR-0009)', (group) => {
  group.each.teardown(async () => {
    app.container.restore(FfmpegTranscoder)
    app.container.restore(ProgressStore)
    app.container.restore(TranscodePublisher)
    app.container.restore(RustfsStorage)
    app.container.restore(ArchiveQueue)
    app.container.restore(WebhookQueue)
    await Transcode.query().delete()
  })

  test('persists the three download renditions (url + bytes) on the row', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000001a1'
    stubTranscoder()
    stubSideEffects()
    webhookSpy()
    await Transcode.create({
      id,
      status: 'PENDING',
      originalFilename: 's.mp3',
      sourceKind: 'audio',
    })

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/source.wav', remote: false })

    const row = await Transcode.findOrFail(id)
    assert.equal(row.status, 'COMPLETED')
    assert.deepEqual(
      row.downloads,
      RENDITIONS.map((r) => ({
        name: r.name,
        url: downloadRenditionUrl(id, r.name),
        bytes: BYTES[r.name],
      }))
    )
    // The duration probed at PROCESSING is still on the row (ADR-0009: already persisted).
    assert.equal(row.durationSeconds, DURATION)
  })

  test('the completion webhook carries the downloads and the duration', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000001a2'
    stubTranscoder()
    stubSideEffects()
    const jobs = webhookSpy()
    await Transcode.create({
      id,
      status: 'PENDING',
      originalFilename: 's.mp3',
      sourceKind: 'audio',
      callbackUrl: 'https://caller.example.com/hook',
    })

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/source.wav', remote: false })

    assert.lengthOf(jobs, 1)
    const { payload } = jobs[0]
    assert.equal(payload.status, 'COMPLETED')
    assert.equal(payload.durationSeconds, DURATION)
    assert.deepEqual(
      payload.downloads,
      RENDITIONS.map((r) => ({
        name: r.name,
        url: downloadRenditionUrl(id, r.name),
        bytes: BYTES[r.name],
      }))
    )
  })

  test('no callbackUrl means no webhook, but the row still carries the downloads', async ({
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-0000000001a3'
    stubTranscoder()
    stubSideEffects()
    const jobs = webhookSpy()
    await Transcode.create({
      id,
      status: 'PENDING',
      originalFilename: 's.mp3',
      sourceKind: 'audio',
    })

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/source.wav', remote: false })

    assert.isEmpty(jobs)
    const row = await Transcode.findOrFail(id)
    assert.lengthOf(row.downloads!, RENDITIONS.length)
  })
})
