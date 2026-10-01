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
  LOUDNESS_TARGET,
  downloadKeyPrefix,
  hlsKeyPrefix,
  outputPlaylistUrl,
  sparksPosterUrl,
} from '#transcodes/support/hls'
import type { LoudnessReport } from '#transcodes/support/hls'
import type { MediaTags } from '#transcodes/support/media_tags'
import { WAVEFORM_BARS } from '#transcodes/support/waveform'

const DURATION = 28.4

/** Les étiquettes que la sonde a lues sur la source. */
const TAGS: MediaTags = { title: 'Rassemblement de jeunesse', artist: null, album: null }

/** Trente-six hauteurs plausibles, dont un début muet. */
const WAVEFORM = Array.from({ length: WAVEFORM_BARS }, (_, bar) => (bar < 3 ? 0 : 40 + bar))

/** Le niveau que `loudnorm` a mesuré, entrée **et** sortie. */
const LOUDNESS: LoudnessReport = {
  targetI: LOUDNESS_TARGET.targetI,
  inputI: -23.01,
  inputTp: -10.78,
  inputLra: 8,
  outputI: -15.71,
  outputTp: -5.03,
  outputLra: 8,
  normalization: 'linear',
}

/**
 * Un encodeur doublé — pas de ffmpeg ici, seulement la forme que l'action
 * consomme. Le vrai ffmpeg est éprouvé par `sparks_transcodage.spec.ts`.
 */
function stubTranscoder(options: { hasVideo?: boolean; poster?: boolean } = {}) {
  const hasVideo = options.hasVideo ?? true
  app.container.swap(FfmpegTranscoder, () => {
    return {
      probe: async () => ({
        hasAudio: true,
        hasVideo,
        durationSeconds: DURATION,
        bitrate: 2_400_000,
        tags: TAGS,
      }),
      analyseSparks: async () => ({
        measured: {
          i: LOUDNESS.inputI,
          tp: LOUDNESS.inputTp,
          lra: LOUDNESS.inputLra,
          thresh: -33.01,
          targetOffset: 1.18,
        },
        waveform: WAVEFORM,
      }),
      encodeSparks: async () => LOUDNESS,
      extractPoster: async () => options.poster ?? true,
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

function archiveSpy() {
  const jobs: ArchiveJobData[] = []
  app.container.swap(ArchiveQueue, () => {
    return {
      enqueue: async (data: ArchiveJobData) => void jobs.push(data),
    } as unknown as ArchiveQueue
  })
  return jobs
}

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
    originalFilename: 'annonce.mp4',
    sourceKind: 'video',
    ...(callbackUrl ? { callbackUrl } : {}),
  })
}

test.group('ProcessTranscode — profil sparks (issue #49)', (group) => {
  group.each.setup(() => {
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

  test('persiste la sortie — playlist, vignette, forme d’onde, niveau, étiquettes', async ({
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a1'
    stubTranscoder()
    rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.mp4',
      remote: false,
      profile: 'sparks',
    })

    const row = await Transcode.findOrFail(id)
    assert.equal(row.status, 'COMPLETED')
    assert.deepEqual(row.sparkMedia, {
      playlist: outputPlaylistUrl(id),
      poster: sparksPosterUrl(id),
      hasVideo: true,
      durationSeconds: DURATION,
      waveform: WAVEFORM,
      loudness: LOUDNESS,
      tags: TAGS,
    })

    // ⚠️ **La différence avec la radio** : il y a bien une playlist, et elle est
    // dans la colonne qui porte son nom. La garde « terminé sans média » de
    // l'appelant n'a rien à apprendre sur ce profil.
    assert.equal(row.outputPlaylist, outputPlaylistUrl(id))
    assert.equal(row.durationSeconds, DURATION)
  })

  test('aucun rendu progressif, et un seul envoi : le préfixe HLS', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a2'
    stubTranscoder()
    const prefixes = rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.mp4',
      remote: false,
      profile: 'sparks',
    })

    const row = await Transcode.findOrFail(id)
    // `null` et non `[]` : la colonne dirait sinon « on a cherché et il n'y en a
    // pas » là où la vérité est « ce profil n'en produit pas ».
    assert.isNull(row.downloads ?? null)

    // Un seul envoi. La vignette voyage **dans** le dossier HLS, donc elle part
    // avec lui — c'est ce qui lui épargne un préfixe, un bloc Caddy et une
    // branche de reprise.
    assert.deepEqual(prefixes, [hlsKeyPrefix(id)])
    assert.notInclude(prefixes, downloadKeyPrefix(id))
  })

  test('le webhook porte la sortie entière', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a3'
    stubTranscoder()
    rustfsSpy()
    archiveSpy()
    const jobs = webhookSpy()
    await seed(id, 'https://portail.example.com/hook')

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.mp4',
      remote: false,
      profile: 'sparks',
    })

    assert.lengthOf(jobs, 1)
    const { payload } = jobs[0]
    assert.equal(payload.status, 'COMPLETED')
    assert.equal(payload.outputPlaylist, outputPlaylistUrl(id))
    assert.equal(payload.durationSeconds, DURATION)
    assert.lengthOf(payload.sparkMedia!.waveform!, WAVEFORM_BARS)
    assert.equal(payload.sparkMedia!.loudness!.normalization, 'linear')
    // Non signées, comme toutes les URL publiées : la vignette et la playlist
    // vivent sur la même origine anonyme.
    assert.notInclude(payload.sparkMedia!.poster!, '?')
    assert.notProperty(payload, 'radioTrack')
  })

  test('un Spark sonore n’a pas de vignette, et le dit', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a4'
    stubTranscoder({ hasVideo: false })
    rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.m4a',
      remote: false,
      profile: 'sparks',
    })

    const row = await Transcode.findOrFail(id)
    // `null`, pas absent : le client distingue « pas d'image » de « champ pas
    // encore servi ».
    assert.isNull(row.sparkMedia!.poster)
    assert.isFalse(row.sparkMedia!.hasVideo)
    // Et la forme d'onde, elle, est là : c'est tout ce qu'un Spark sonore a à
    // montrer.
    assert.lengthOf(row.sparkMedia!.waveform!, WAVEFORM_BARS)
  })

  test('une vignette qu’on n’a pas su tirer ne fait pas échouer le Spark', async ({ assert }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a5'
    stubTranscoder({ poster: false })
    rustfsSpy()
    archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.mp4',
      remote: false,
      profile: 'sparks',
    })

    const row = await Transcode.findOrFail(id)
    // Refuser le dépôt échangerait un carré noir contre **rien du tout**, et
    // `poster: null` dit ce qui s'est passé là où un `FAILED` laisserait croire
    // que le média était mauvais.
    assert.equal(row.status, 'COMPLETED')
    assert.isNull(row.sparkMedia!.poster)
    assert.isTrue(row.sparkMedia!.hasVideo)
  })

  test('le job d’archivage reçoit le profil, pour ne jamais encoder de FLAC', async ({
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-0000000003a6'
    stubTranscoder()
    rustfsSpy()
    const jobs = archiveSpy()
    webhookSpy()
    await seed(id)

    const action = await app.container.make(ProcessTranscode)
    await action.execute({
      id,
      source: '/nonexistent/annonce.mp4',
      remote: false,
      profile: 'sparks',
    })

    assert.lengthOf(jobs, 1)
    // ⚠️ La garde d'`ArchiveTranscode` est en **liste blanche** : écrite
    // `!== 'radio'`, elle aurait laissé ce profil produire un FLAC sans que
    // personne l'ait décidé.
    assert.equal(jobs[0].profile, 'sparks')
  })
})
