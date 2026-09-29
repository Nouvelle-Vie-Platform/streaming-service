import { test } from '@japa/runner'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import {
  RADIO_FORMAT,
  RADIO_LOUDNESS,
  archivePath,
  downloadOutputDir,
  hlsOutputDir,
  radioOutputDir,
  radioTrackPath,
} from '#transcodes/support/hls'
import app from '@adonisjs/core/services/app'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Une source synthétique courte, en **bruit rose** : quasi incompressible, donc
 * le débit cible est réellement atteint et une assertion sur les octets n'est pas
 * instable (même raison que `download_renditions.spec.ts`). Assez longue pour que
 * la loudness intégrée d'EBU R128 ait de quoi se prononcer.
 */
const SOURCE_SECONDS = 6

/**
 * **Vingt décibels d'écart** entre les deux sources — c'est tout le sujet de la
 * tranche. Un titre enregistré au ras du zéro et un autre enregistré timidement
 * doivent ressortir au **même** niveau, sinon l'auditeur corrige son volume à
 * chaque enchaînement.
 */
const LEVELS = { fort: 0.5, faible: 0.05 }

/** Un champ de la sonde, sur la première piste audio. */
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

/**
 * La loudness intégrée d'un fichier, **mesurée par un autre chemin que celui
 * qu'on teste**.
 *
 * `loudnorm` publie son propre chiffre ; le vérifier avec `loudnorm` serait
 * demander au témoin de confirmer son témoignage. `ebur128` est l'autre filtre
 * d'ffmpeg, indépendant, et c'est lui qui tranche ici.
 */
async function integratedLoudness(path: string): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-af',
    'ebur128=framelog=quiet',
    '-f',
    'null',
    '-',
  ])
  // Le résumé imprime « I: -16.0 LUFS » ; la première occurrence est la
  // loudness intégrée (celles qui suivent appartiennent à la plage).
  const match = /I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(stderr)
  if (!match) throw new Error(`ebur128 n'a rien dit de lisible :\n${stderr.slice(-1500)}`)
  return Number(match[1])
}

test.group('profil radio — vraie passe ffmpeg, niveau normalisé (issue #46)', (group) => {
  const ids = {
    fort: `test-radio-fort-${Date.now()}`,
    faible: `test-radio-faible-${Date.now()}`,
    etiquete: `test-radio-tags-${Date.now()}`,
  }
  const sources: Record<string, string> = {}

  group.setup(async () => {
    const dir = app.makePath('storage/test-sources')
    await mkdir(dir, { recursive: true })

    for (const [name, amplitude] of Object.entries(LEVELS)) {
      sources[name] = join(dir, `${ids[name as keyof typeof LEVELS]}.wav`)
      await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anoisesrc=d=${SOURCE_SECONDS}:c=pink:a=${amplitude}`,
        '-c:a',
        'pcm_s16le',
        sources[name],
      ])
    }

    // Une source **étiquetée**, pour la sonde étendue. MP4 range ses métadonnées
    // au niveau du conteneur, et annonce un débit.
    sources.etiquete = join(dir, `${ids.etiquete}.m4a`)
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `anoisesrc=d=2:c=pink:a=0.3`,
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-metadata',
      'title=Jésus est vivant',
      '-metadata',
      'artist=Chorale Nouvelle Vie',
      '-metadata',
      'album=Louange 2026',
      sources.etiquete,
    ])

    return async () => {
      for (const path of Object.values(sources)) await rm(path, { force: true })
      for (const id of Object.values(ids)) {
        await rm(radioOutputDir(id), { recursive: true, force: true })
        await rm(hlsOutputDir(id), { recursive: true, force: true })
        await rm(downloadOutputDir(id), { recursive: true, force: true })
      }
    }
  })

  test('deux sources à 20 dB d’écart ressortent au même niveau mesuré', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()
    const measuredOut: Record<string, number> = {}
    const reported: Record<string, number> = {}

    for (const name of ['fort', 'faible'] as const) {
      const id = ids[name]
      const measured = await transcoder.measureLoudness(sources[name])
      assert.isNotNull(measured, `${name} : la passe d'analyse n'a rien mesuré`)

      const result = await transcoder.encodeRadio(
        sources[name],
        id,
        measured,
        SOURCE_SECONDS,
        () => {}
      )
      assert.isAbove(result.bytes, 0, `${name} : fichier vide`)
      assert.isNotNull(result.loudness, `${name} : aucun niveau publié`)

      measuredOut[name] = await integratedLoudness(radioTrackPath(id))
      reported[name] = result.loudness!.outputI
    }

    // **L'assertion qui prouve que la tranche fait ce qu'elle promet.** Les deux
    // sources sont à 20 dB l'une de l'autre ; leurs sorties ne doivent plus se
    // distinguer à l'oreille.
    assert.closeTo(
      measuredOut.fort,
      measuredOut.faible,
      1,
      `niveaux encore distincts : fort=${measuredOut.fort} faible=${measuredOut.faible} LUFS`
    )

    for (const name of ['fort', 'faible'] as const) {
      assert.closeTo(
        measuredOut[name],
        RADIO_LOUDNESS.targetI,
        1.5,
        `${name} : ${measuredOut[name]} LUFS, cible ${RADIO_LOUDNESS.targetI}`
      )

      // Le niveau **publié** dans le webhook est bien celui du fichier, et non
      // une prédiction : c'est cette égalité qui autorise le portail à s'y fier
      // sans remesurer.
      assert.closeTo(
        reported[name],
        measuredOut[name],
        1,
        `${name} : niveau annoncé ${reported[name]}, mesuré ${measuredOut[name]}`
      )
    }
  }).timeout(120_000)

  test('la sortie est un seul AAC en MP4, à 48 kHz et au débit unique', async ({ assert }) => {
    // Le fichier a été écrit par le test précédent ; on l'inspecte plutôt que de
    // repayer une passe.
    const path = radioTrackPath(ids.fort)
    assert.isTrue(existsSync(path), 'la piste radio du test précédent a disparu')

    assert.equal(await probeField(path, 'stream=codec_name'), RADIO_FORMAT.codec)

    // ⚠️ **La panne évitée.** `loudnorm` travaille — et sort — en 192 kHz. Sans
    // `-ar`, l'encodeur AAC écrit un fichier bien plus lourd que le débit
    // demandé, que certains lecteurs refusent. Et il joue en local, donc rien ne
    // le signale.
    assert.equal(
      await probeField(path, 'stream=sample_rate'),
      String(RADIO_FORMAT.sampleRate),
      'loudnorm a laissé passer sa fréquence interne'
    )

    // ⚠️ **La durée est portée par le conteneur, à la seconde.** C'est pour ça
    // que ce profil est en MP4 et non en ADTS comme les téléchargements : un
    // ADTS n'a pas d'index, sa durée est *estimée* depuis la taille, et l'antenne
    // calcule ses fondus dessus.
    const duration = Number(await probeField(path, 'stream=duration'))
    assert.closeTo(duration, SOURCE_SECONDS, 0.2, 'durée du conteneur infidèle')

    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=bit_rate:stream=codec_type',
      '-of',
      'json',
      path,
    ])
    const data = JSON.parse(stdout) as {
      streams?: { codec_type?: string }[]
      format?: { bit_rate?: string }
    }

    // Un seul flux, et il est audio : la piste vidéo d'un conteneur est jetée
    // (ADR-0001) et il n'y a pas d'échelle de rendus sur ce profil.
    assert.lengthOf(data.streams ?? [], 1)
    assert.equal(data.streams?.[0]?.codec_type, 'audio')

    // Le bruit rose est quasi incompressible : le débit demandé est réellement
    // atteint, donc l'assertion n'est pas instable.
    const bitrate = Number(data.format?.bit_rate)
    assert.isAbove(bitrate, 100_000, `débit ${bitrate} : la cible 128k n'est pas atteinte`)
    assert.isBelow(bitrate, 170_000, `débit ${bitrate} : bien au-delà de la cible 128k`)
  })

  test('le profil radio ne produit ni HLS, ni rendus progressifs, ni archive', async ({
    assert,
  }) => {
    // Le périmètre de la tranche, en assertions négatives : segmenter une chanson
    // de trois minutes n'apporte rien, et le master reste chez l'appelant.
    const id = ids.fort
    assert.isFalse(existsSync(hlsOutputDir(id)), 'un jeu HLS a été produit')
    assert.isFalse(existsSync(downloadOutputDir(id)), 'des rendus progressifs ont été produits')
    assert.isFalse(existsSync(archivePath(id)), 'une archive FLAC a été produite')
  })

  test('la sonde rend le débit et les étiquettes de la source', async ({ assert }) => {
    const transcoder = new FfmpegTranscoder()
    const probe = await transcoder.probe(sources.etiquete)

    assert.isTrue(probe.hasAudio)
    assert.closeTo(probe.durationSeconds!, 2, 0.3)
    // Le portail les proposera à l'administrateur comme valeurs par défaut au
    // dépôt : ce sont les étiquettes de **la source**, pas de ce qu'on produit.
    assert.deepEqual(probe.tags, {
      title: 'Jésus est vivant',
      artist: 'Chorale Nouvelle Vie',
      album: 'Louange 2026',
    })
    assert.isNotNull(probe.bitrate)
    assert.isAbove(probe.bitrate!, 0)
  })

  test('une source sans étiquette rend trois champs nuls, et non une absence', async ({
    assert,
  }) => {
    const transcoder = new FfmpegTranscoder()
    const probe = await transcoder.probe(sources.fort)

    // Toujours un objet : l'appelant n'a pas à distinguer « pas d'étiquettes » de
    // « pas de sonde ».
    assert.deepEqual(probe.tags, { title: null, artist: null, album: null })
    assert.isTrue(probe.hasAudio)
  })
})
