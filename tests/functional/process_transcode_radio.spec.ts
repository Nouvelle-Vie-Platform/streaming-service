import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Transcode from '#transcodes/models/transcode'
import { ProcessTranscode } from '#transcodes/actions/process_transcode'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { ProgressStore } from '#transcodes/services/progress_store'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { ArchiveQueue, type ArchiveJobData } from '#transcodes/queues/archive_queue'
import { WebhookQueue, type WebhookJobData } from '#transcodes/queues/webhook_queue'
import {
  RADIO_LOUDNESS,
  RENDITIONS,
  downloadKeyPrefix,
  hlsKeyPrefix,
  radioKeyPrefix,
  radioTrackUrl,
} from '#transcodes/support/hls'
import type { RadioLoudness } from '#transcodes/support/hls'
import type { MediaTags } from '#transcodes/support/media_tags'

const DURATION = 187.25
const BYTES = 2_996_000

/** Les étiquettes que la sonde a lues sur la source. */
const TAGS: MediaTags = {
  title: 'Jésus est vivant',
  artist: 'Chorale Nouvelle Vie',
  album: 'Louange 2026',
}

/** Le niveau que `loudnorm` a mesuré, entrée **et** sortie. */
const LOUDNESS: RadioLoudness = {
  targetI: RADIO_LOUDNESS.targetI,
  inputI: -27.5,
  inputTp: -3.25,
  inputLra: 4.75,
  outputI: -16.02,
  outputTp: -4.1,
  outputLra: 4.7,
  normalization: 'linear',
}

/** Un encodeur doublé : pas de ffmpeg, seulement la forme que l'action consomme. */
function stubTranscoder() {
  const downloads = RENDITIONS.map((r) => ({ name: r.name, bitrate: r.bitrate, bytes: 1_000 }))
  app.container.swap(FfmpegTranscoder, () => {
    return {
      probe: async () => ({
        hasAudio: true,
        durationSeconds: DURATION,
        bitrate: 320_000,
        tags: TAGS,
      }),
      measureLoudness: async () => ({
        i: LOUDNESS.inputI,
        tp: LOUDNESS.inputTp,
        lra: LOUDNESS.inputLra,
        thresh: -37.9,
        targetOffset: 0.15,
      }),
      encodeRadio: async () => ({ bytes: BYTES, loudness: LOUDNESS }),
      measureRadioTrack: async () => BYTES,
      encode: async () => ({ downloads }),
      measureDownloads: async () => downloads,
      // La ligne de mesure porte la version de ffmpeg : un double qui l'omettrait
      // ferait échouer l'action sur un champ de journal, ce qui est déjà arrivé.
      version: async () => '7.1.5-test',
    } as unknown as FfmpegTranscoder
  })
}

/** Note **sous quel préfixe** chaque envoi part, sans toucher de bucket. */
function rustfsSpy() {
  const prefixes: string[] = []
  app.container.swap(RustfsStorage, () => {
    return {
      uploadDirectory: async (_dir: string, prefix: string) => {
        prefixes.push(prefix)
        return 1
      },
    } as unknown as RustfsStorage
  })
  return prefixes
}

/** Fait taire les collaborateurs à effet de bord. */
function stubSideEffects() {
  app.container.swap(ProgressStore, () => {
    return { set: async () => {}, clear: async () => {} } as unknown as ProgressStore
  })
  app.container.swap(TranscodePublisher, () => {
    return { broadcast: () => {} } as unknown as TranscodePublisher
  })
}

/** Capture le job d'archivage au lieu de l'enfiler. */
function archiveSpy() {
  const jobs: ArchiveJobData[] = []
  app.container.swap(ArchiveQueue, () => {
    return {
      enqueue: async (data: ArchiveJobData) => void jobs.push(data),
    } as unknown as ArchiveQueue
  })
  return jobs
}

/** Capture le webhook de complétion au lieu de l'enfiler. */
function webhookSpy() {
  const jobs: WebhookJobData[] = []
  app.container.swap(WebhookQueue, () => {
    return {
      enqueue: async (data: WebhookJobData) => void jobs.push(data),
    } as unknown as WebhookQueue
  })
  return jobs
}

async function seed(id: string, callbackUrl?: string) {
  return Transcode.create({
    id,
    status: 'PENDING',
    originalFilename: 'titre.mp3',
    sourceKind: 'audio',
    ...(callbackUrl ? { callbackUrl } : {}),
  })
}

test.group('ProcessTranscode — profil radio (issue #46)', (group) => {
  group.each.setup(() => {
    stubTranscoder()
    stubSideEffects()
  })
  group.each.teardown(async () => {
    app.container.restore(FfmpegTranscoder)
    app.container.restore(ProgressStore)
    app.container.restore(TranscodePublisher)
    app.container.restore(RustfsStorage)
    app.container.restore(ArchiveQueue)
    app.container.restore(WebhookQueue)
    await Transcode.query().delete()
  })

  test('persiste la piste radio — url, octets, niveau, étiquettes', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000002a1'
    rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/titre.mp3', remote: false, profile: 'radio' })

    const row = await Transcode.findOrFail(id)
    assert.equal(row.status, 'COMPLETED')
    assert.deepEqual(row.radioTrack, {
      url: radioTrackUrl(id),
      bytes: BYTES,
      loudness: LOUDNESS,
      tags: TAGS,
    })
    assert.equal(row.durationSeconds, DURATION)
  })

  test('ni playlist ni rendus progressifs sur la ligne', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000002a2'
    const prefixes = rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/titre.mp3', remote: false, profile: 'radio' })

    const row = await Transcode.findOrFail(id)
    // `output_playlist` reste nul : **il n'y a pas de playlist**. Y ranger l'URL
    // du `.m4a` ferait mentir le nom de la colonne.
    assert.isNull(row.outputPlaylist ?? null)
    assert.isNull(row.downloads ?? null)

    // Un seul envoi, et il part sous le préfixe radio : rien n'a été poussé sous
    // `hls/` pour ce transcodage, donc rien n'y survivra à sa reprise.
    assert.deepEqual(prefixes, [radioKeyPrefix(id)])
    assert.notInclude(prefixes, hlsKeyPrefix(id))
  })

  test('le webhook porte l’url unique, la durée, le niveau et les étiquettes', async ({
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-0000000002a3'
    rustfsSpy()
    archiveSpy()
    const jobs = webhookSpy()
    await seed(id, 'https://portail.example.com/hook')

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/titre.mp3', remote: false, profile: 'radio' })

    assert.lengthOf(jobs, 1)
    const { payload } = jobs[0]
    assert.equal(payload.status, 'COMPLETED')
    // L'antenne a besoin de la durée à la seconde pour ses fondus et ses coupures.
    assert.equal(payload.durationSeconds, DURATION)
    assert.deepEqual(payload.radioTrack, {
      url: radioTrackUrl(id),
      bytes: BYTES,
      loudness: LOUDNESS,
      tags: TAGS,
    })
    // Non signée : une URL qui expire en pleine diffusion ferait taire l'antenne
    // au milieu d'un titre.
    assert.notInclude(payload.radioTrack!.url, '?')
    assert.isNull(payload.outputPlaylist)
    assert.isEmpty(payload.downloads)
  })

  test('le job d’archivage reçoit le profil, pour ne jamais encoder de FLAC', async ({
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-0000000002a4'
    rustfsSpy()
    const jobs = archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({ id, source: '/nonexistent/titre.mp3', remote: false, profile: 'radio' })

    assert.lengthOf(jobs, 1)
    assert.equal(jobs[0].profile, 'radio')
  })

  test('le régime des enseignements ne bouge pas d’un champ', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000002a5'
    const prefixes = rustfsSpy()
    archiveSpy()
    const jobs = webhookSpy()
    await seed(id, 'https://portail.example.com/hook')

    const action = await app.container.make(ProcessTranscode)
    // Aucun profil : exactement la requête d'avant cette tranche.
    await action.execute({ id, source: '/nonexistent/sermon.mp3', remote: false })

    const row = await Transcode.findOrFail(id)
    assert.equal(row.status, 'COMPLETED')
    assert.isNotNull(row.outputPlaylist)
    assert.lengthOf(row.downloads!, RENDITIONS.length)
    assert.isNull(row.radioTrack ?? null)

    // **La garde de non-régression du contrat.** Un champ de plus, même vide,
    // serait un changement de charge utile pour un consommateur qui n'a rien
    // demandé.
    assert.notProperty(jobs[0].payload, 'radioTrack')
    assert.deepEqual(prefixes, [hlsKeyPrefix(id), downloadKeyPrefix(id)])
  })
})
