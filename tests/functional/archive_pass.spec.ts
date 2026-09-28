import { test } from '@japa/runner'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { archivePath, downloadOutputDir, hlsOutputDir } from '#transcodes/support/hls'
import app from '@adonisjs/core/services/app'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const SOURCE_SECONDS = 3

/**
 * **L'archive FLAC a quitté la passe de service** — et c'est tout ce que ces
 * tests surveillent.
 *
 * Le découpage vient d'une mesure, pas d'une intuition : l'encodage occupe 94 %
 * d'un transcodage et tourne dans un **seul fil**, si bien que le FLAC retardait
 * le moment où l'enseignement devient écoutable — pour un fichier de
 * conservation que personne n'attend avant `COMPLETED`.
 *
 * Ce qui se casserait sans ces tests ne ferait rougir rien d'autre : une passe
 * qui continuerait d'écrire le FLAC annulerait le gain **en silence**, et une
 * passe d'archive muette laisserait une conservation vide — qu'on ne
 * découvrirait qu'en cherchant un original, des mois plus tard.
 */
test.group('la passe d’archive — ffmpeg réel', (group) => {
  const id = `test-archive-${Date.now()}`
  let sourcePath: string

  group.setup(async () => {
    const dir = app.makePath('storage/test-sources')
    await mkdir(dir, { recursive: true })
    sourcePath = join(dir, `${id}.wav`)
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

    return async () => {
      await rm(sourcePath, { force: true })
      await rm(hlsOutputDir(id), { recursive: true, force: true })
      await rm(downloadOutputDir(id), { recursive: true, force: true })
      await rm(archivePath(id), { force: true })
    }
  })

  test('la passe de service n’écrit plus le FLAC', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()

    await transcoder.encode(sourcePath, id, SOURCE_SECONDS, () => {})

    // Le HLS est bien là — la passe a fait son travail…
    assert.isTrue(existsSync(join(hlsOutputDir(id), 'master.m3u8')))
    // …et l'archive n'y est pas. C'est *ce* fichier absent qui vaut le gain :
    // s'il réapparaissait, l'encodage redeviendrait sérialisé sur quatre
    // sorties et personne ne le remarquerait.
    assert.isFalse(
      existsSync(archivePath(id)),
      'le FLAC ne doit plus sortir de la passe de service'
    )
  })

  test('la passe d’archive produit un FLAC décodable', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()

    await transcoder.encodeArchive(sourcePath, id)

    assert.isTrue(existsSync(archivePath(id)))
    const { size } = await stat(archivePath(id))
    assert.isAbove(size, 0)

    // Pas seulement « un fichier existe » : le codec est bien celui de la
    // conservation. Un FLAC vide ou un AAC déguisé passerait le test précédent.
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      archivePath(id),
    ])
    assert.equal(stdout.trim(), 'flac')
  })

  test('elle est rejouable, et rend le même fichier', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()

    await transcoder.encodeArchive(sourcePath, id)
    const first = await stat(archivePath(id))

    // Un rejeu après un envoi refusé doit pouvoir repasser ici sans rien
    // abîmer : `-y` réécrit, et la même source rend la même taille.
    await transcoder.encodeArchive(sourcePath, id)
    const second = await stat(archivePath(id))

    assert.equal(second.size, first.size)
  })
})
