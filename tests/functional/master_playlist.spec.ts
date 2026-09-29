import { test } from '@japa/runner'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import {
  RENDITIONS,
  downloadOutputDir,
  downloadRenditionPath,
  hlsOutputDir,
  masterPlaylistPath,
  variantPlaylistPath,
} from '#transcodes/support/hls'
import app from '@adonisjs/core/services/app'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Assez long pour produire plusieurs segments, dont un dernier plus court. */
const SOURCE_SECONDS = 14

/**
 * **`master.m3u8` est désormais notre fichier**, et c'est le plus exposé du
 * service : tous les téléphones le demandent en premier. Un lecteur qui le lit
 * mal choisit mal, ou ne joue rien — et rien dans nos journaux ne le dirait.
 *
 * Il l'était écrit par ffmpeg, comme effet de bord de `-var_stream_map`, qui
 * exige que les trois rendus sortent d'une **seule** invocation : donc d'un seul
 * fil, les encodages se suivant. Un processus par rendu les fait tourner
 * ensemble ; ce fichier est le prix, et ces tests sont ce qui le rend payable.
 *
 * La méthode : encoder le **même** extrait des deux façons, et comparer. Ce
 * n'est pas une vérification de forme — c'est la seule qui dise que les
 * `BANDWIDTH` annoncés correspondent aux octets réellement écrits, et le jour où
 * ffmpeg changera de convention, c'est ce test qui le dira plutôt qu'un fidèle
 * dont le lecteur reste muet.
 */
test.group('master.m3u8 — le nôtre contre celui de ffmpeg', (group) => {
  const id = `test-master-${Date.now()}`
  let sourcePath: string
  let temoin: string

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

    // Le **témoin** : la sortie que ffmpeg produisait avant le découpage, avec
    // `-var_stream_map` et son `-master_pl_name`. C'est la référence.
    temoin = app.makePath('storage/test-temoin', id)
    for (const rendition of RENDITIONS) {
      await mkdir(join(temoin, rendition.name), { recursive: true })
    }
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      sourcePath,
      '-vn',
      '-nostats',
      ...RENDITIONS.flatMap(() => ['-map', '0:a:0']),
      '-c:a',
      'aac',
      ...RENDITIONS.flatMap((rendition, index) => [`-b:a:${index}`, rendition.bitrate]),
      '-f',
      'hls',
      '-hls_time',
      '6',
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-master_pl_name',
      'master.m3u8',
      '-var_stream_map',
      RENDITIONS.map((r, i) => `a:${i},name:${r.name}`).join(' '),
      '-hls_segment_filename',
      join(temoin, '%v', 'seg_%03d.ts'),
      join(temoin, '%v', 'index.m3u8'),
    ])

    return async () => {
      await rm(sourcePath, { force: true })
      await rm(temoin, { recursive: true, force: true })
      await rm(hlsOutputDir(id), { recursive: true, force: true })
      await rm(downloadOutputDir(id), { recursive: true, force: true })
    }
  })

  /** `BANDWIDTH` et `AVERAGE-BANDWIDTH` de chaque variante d'un master. */
  function bandwidths(playlist: string): { peak: number; average: number; uri: string }[] {
    const lines = playlist.split('\n')
    const variants: { peak: number; average: number; uri: string }[] = []
    for (const [index, line] of lines.entries()) {
      const match = /BANDWIDTH=(\d+),AVERAGE-BANDWIDTH=(\d+)/.exec(line)
      if (!match) continue
      variants.push({
        peak: Number(match[1]),
        average: Number(match[2]),
        uri: lines[index + 1]!.trim(),
      })
    }
    return variants
  }

  test('les trois variantes, dans l’ordre, aux mêmes adresses', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()
    await transcoder.encode(sourcePath, id, SOURCE_SECONDS, () => {})

    const notre = await readFile(masterPlaylistPath(id), 'utf8')
    const reference = await readFile(join(temoin, 'master.m3u8'), 'utf8')

    // L'ordre compte : un lecteur qui ne sait pas mesurer son débit prend
    // souvent la **première** variante. La nôtre doit rester le rendu bas.
    assert.deepEqual(
      bandwidths(notre).map((v) => v.uri),
      bandwidths(reference).map((v) => v.uri)
    )
    assert.deepEqual(
      bandwidths(notre).map((v) => v.uri),
      RENDITIONS.map((r) => `${r.name}/index.m3u8`)
    )
  })

  test('les débits annoncés collent à ceux de ffmpeg', async ({ assert }) => {
    const notre = bandwidths(await readFile(masterPlaylistPath(id), 'utf8'))
    const reference = bandwidths(await readFile(join(temoin, 'master.m3u8'), 'utf8'))

    for (const [index, variant] of notre.entries()) {
      const attendu = reference[index]!
      // 2 % de tolérance : les deux encodages ne sont pas bit-à-bit identiques
      // (ffmpeg n'est pas déterministe à ce point sur du bruit), mais un écart
      // plus grand voudrait dire qu'on ne mesure pas la même chose.
      assert.closeTo(variant.peak, attendu.peak, attendu.peak * 0.02, `pic du rendu ${index}`)
      assert.closeTo(
        variant.average,
        attendu.average,
        attendu.average * 0.02,
        `moyenne du rendu ${index}`
      )
      // **Le pic est au-dessus de la moyenne**, jamais l'inverse : c'est le sens
      // de l'attribut (RFC 8216), et l'annoncer trop bas fait choisir un rendu
      // qu'on ne peut pas soutenir — exactement la panne que l'échelle évite.
      assert.isAtLeast(variant.peak, variant.average)
    }

    // Et ils croissent avec l'échelle : un master dont les débits ne seraient
    // pas ordonnés ferait choisir n'importe quoi.
    const pics = notre.map((v) => v.peak)
    assert.deepEqual(pics, [...pics].sort((a, b) => a - b))
  })

  test('l’en-tête est celui que ffmpeg écrit', async ({ assert }) => {
    const notre = await readFile(masterPlaylistPath(id), 'utf8')
    const reference = await readFile(join(temoin, 'master.m3u8'), 'utf8')

    // Version de playlist et codec déclaré : recopiés du témoin, pas devinés.
    // `mp4a.40.2` est l'AAC-LC que `-c:a aac` produit ; annoncer autre chose
    // ferait refuser le flux par les lecteurs stricts.
    assert.isTrue(notre.startsWith('#EXTM3U\n'))
    assert.include(notre, '#EXT-X-VERSION:6')
    assert.include(reference, '#EXT-X-VERSION:6')
    assert.equal((notre.match(/CODECS="mp4a\.40\.2"/g) ?? []).length, RENDITIONS.length)
  })

  test('chaque rendu a sa playlist, ses segments et son .aac', async ({ assert }) => {
    for (const rendition of RENDITIONS) {
      const playlist = await readFile(variantPlaylistPath(id, rendition.name), 'utf8')
      assert.include(playlist, '#EXT-X-ENDLIST', `${rendition.name} : playlist inachevée`)
      assert.match(playlist, /seg_000\.ts/)
      // Le `.aac` du même rendu sort du **même** processus : s'il manquait, le
      // découpage aurait perdu la moitié de son travail sans rien dire.
      assert.isTrue(
        existsSync(downloadRenditionPath(id, rendition.name)),
        `${rendition.name} : .aac manquant`
      )
    }
  })
})
