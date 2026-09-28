import { test } from '@japa/runner'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import {
  RENDITIONS,
  downloadOutputDir,
  downloadRenditionPath,
  hlsOutputDir,
} from '#transcodes/support/hls'
import app from '@adonisjs/core/services/app'
import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A short synthetic clip, so the pass has real audio to decode (spike #183).
 * Pink noise (not a pure tone) is near-incompressible, so each ladder rung
 * actually fills its target bitrate — the byte sizes then separate cleanly and
 * the "higher bitrate = bigger file" assertion is not flaky.
 */
const SOURCE_SECONDS = 4

/** ffprobe a single stream/format field of a media file. */
async function probeField(path: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    entry,
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return stdout.trim()
}

test.group('download renditions — real ffmpeg pass (ADR-0009)', (group) => {
  const id = `test-dl-${Date.now()}`
  let sourcePath: string

  group.setup(async () => {
    const dir = app.makePath('storage/test-sources')
    await mkdir(dir, { recursive: true })
    sourcePath = join(dir, `${id}.wav`)
    // Generate a real audio Source with the system ffmpeg (present in CI/dev).
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anoisesrc=d=${SOURCE_SECONDS}:c=pink:a=0.5`,
      '-c:a',
      'pcm_s16le',
      sourcePath,
    ])

    // Teardown: reclaim everything the pass staged locally.
    return async () => {
      await rm(sourcePath, { force: true })
      await rm(hlsOutputDir(id), { recursive: true, force: true })
      await rm(downloadOutputDir(id), { recursive: true, force: true })
    }
  })

  test('one pass writes three .aac at the 64/128/192k ladder', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()

    // La passe de service n'écrit plus le FLAC — il a sa propre passe, dans le
    // job d'archivage (voir l'en-tête de `FfmpegTranscoder`).
    const result = await transcoder.encode(sourcePath, id, SOURCE_SECONDS, () => {})

    // The encoder reports one measured rendition per ladder rung.
    assert.lengthOf(result.downloads, RENDITIONS.length)
    assert.deepEqual(
      result.downloads.map((d) => d.name),
      RENDITIONS.map((r) => r.name)
    )

    for (const rendition of result.downloads) {
      const path = downloadRenditionPath(id, rendition.name)

      // The measured byte size is the actual file, and it is real audio.
      assert.isAbove(rendition.bytes, 0, `${rendition.name} is non-empty`)

      // Each prefix is decodable AAC (ADTS), and its duration is honest — the
      // spike #183 property that keeps the client's seek bar truthful.
      assert.equal(await probeField(path, 'stream=codec_name'), 'aac', rendition.name)
      const duration = Number(await probeField(path, 'stream=duration'))
      assert.closeTo(duration, SOURCE_SECONDS, 0.5, `${rendition.name} duration honest`)
    }

    // Same source, same duration: a higher target bitrate must yield a bigger
    // file. This is what proves the ladder was actually applied per output.
    const [low, mid, high] = result.downloads.map((d) => d.bytes)
    assert.isAbove(mid, low, 'mid heavier than low')
    assert.isAbove(high, mid, 'high heavier than mid')
  })

  test('measureDownloads recovers the sizes without re-encoding (checkpoint retry)', async ({
    assert,
  }) => {
    const transcoder = new FfmpegTranscoder()

    // The files are already on disk from the previous test's pass; the retry
    // path in ProcessTranscode reads their sizes back rather than re-encoding.
    const measured = await transcoder.measureDownloads(id)
    assert.lengthOf(measured, RENDITIONS.length)
    for (const rendition of measured) {
      assert.isAbove(rendition.bytes, 0)
    }
  })
})
