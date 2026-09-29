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
 * Le résumé d'`ebur128` sur un fichier — ou sur **une tranche** de fichier, quand
 * `slice` est donné : la loudness intégrée et la plage de loudness, **mesurées par
 * un autre chemin que celui qu'on teste**.
 *
 * `loudnorm` publie ses propres chiffres ; les vérifier avec `loudnorm` serait
 * demander au témoin de confirmer son témoignage. `ebur128` est l'autre filtre
 * d'ffmpeg, indépendant, et c'est lui qui tranche ici.
 *
 * `-ss`/`-t` sont placés **avant** `-i` : c'est ce qui fait découper la source à
 * la lecture, et non le fichier entier décodé puis jeté.
 */
async function ebur128(
  path: string,
  slice?: { from: number; seconds: number }
): Promise<{ i: number; lra: number }> {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    ...(slice ? ['-ss', String(slice.from), '-t', String(slice.seconds)] : []),
    '-i',
    path,
    '-af',
    'ebur128=framelog=quiet',
    '-f',
    'null',
    '-',
  ])
  // Le résumé imprime « I:  <n> LUFS » puis « LRA:  <n> LU » ; dans les deux cas
  // la première occurrence est la bonne — celles qui suivent appartiennent au
  // détail de la plage (`LRA low`, `LRA high`), et le deux-points collé au nom
  // les écarte.
  const i = /I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(stderr)
  const lra = /LRA:\s+(-?\d+(?:\.\d+)?) LU/.exec(stderr)
  if (!i || !lra) throw new Error(`ebur128 n'a rien dit de lisible :\n${stderr.slice(-1500)}`)
  return { i: Number(i[1]), lra: Number(lra[1]) }
}

/** La seule loudness intégrée, pour les tests qui ne regardent pas la plage. */
async function integratedLoudness(path: string): Promise<number> {
  const summary = await ebur128(path)
  return summary.i
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

/**
 * **Le gain constant, prouvé sur un fichier produit** — le trou que la tranche
 * laissait ouvert (issue #46).
 *
 * Les quatre autres tests qui mentionnent `linear` portent sur des doublures ou
 * sur la **chaîne d'arguments** passée à ffmpeg. Aucun ne regardait une vraie
 * sortie. Or c'est le gain constant qui justifie le **second décodage**, et donc
 * les +76 % de temps de mur mesurés dans l'ADR-0010 : sans ce groupe, le seul
 * argument de la décision la plus coûteuse de la tranche n'était vérifié nulle
 * part.
 *
 * ## Pourquoi cette source, et pas du bruit rose nu
 *
 * Le bruit rose est le bon signal pour le **débit** (incompressible) mais c'est un
 * cas **dégénéré** pour la normalisation : sa plage de loudness est quasi nulle,
 * donc « préserver la dynamique » n'y veut rien dire. Il faut une source qui ait
 * une vraie plage, et qui remplisse en plus les deux conditions auxquelles
 * `loudnorm` soumet son mode `linear` — voir {@link buildDynamicSource}.
 */
test.group('profil radio — le gain constant, sur une vraie sortie (issue #46)', (group) => {
  /** Durée d'un bloc fort ou faible, en secondes. */
  const BLOCK_SECONDS = 10
  /** Quatre blocs : fort, faible, fort, faible. */
  const DYNAMIC_SECONDS = BLOCK_SECONDS * 4
  /** Le creux, en fraction d'amplitude — ≈ 8 LU sous les sommets. */
  const QUIET_FACTOR = 0.4

  const ids = {
    linear: `test-radio-linear-${Date.now()}`,
    dynamique: `test-radio-dynamique-${Date.now()}`,
  }
  let sourcePath: string
  let measured: Awaited<ReturnType<FfmpegTranscoder['measureLoudness']>>
  let linearResult: Awaited<ReturnType<FfmpegTranscoder['encodeRadio']>>

  /**
   * Une source à **dynamique réelle**, taillée pour que `loudnorm` accepte son
   * mode `linear`. Les deux conditions ont été trouvées au banc, et elles
   * expliquent la forme de ce signal :
   *
   * 1. **`measured_LRA` ≤ `LRA` cible (11 LU).** Un gain constant ne peut pas
   *    réduire une plage ; si la source déborde la cible, `loudnorm` retombe en
   *    dynamique. D'où des blocs à ≈ 8 LU d'écart, et non 20.
   * 2. **`measured_TP` + gain ≤ `TP` cible (-1,5 dBTP).** C'est la contrainte qui
   *    mord le plus, et elle est contre-intuitive : elle porte sur le **facteur de
   *    crête**, pas sur la dynamique. Du bruit rose nu a ≈ 14 LU entre son pic et
   *    sa loudness ; lui creuser des blocs faibles abaisse la loudness sans
   *    toucher le pic, le facteur de crête grimpe, et le gain demandé ferait
   *    dépasser le pic cible. C'est pourquoi le bruit passe ici par un
   *    **limiteur** : il en ressort avec un facteur de crête d'environ 12 LU, ce
   *    qui laisse la marge — et c'est aussi ce à quoi ressemble un master de
   *    musique, écrêté avant livraison.
   *
   * Les blocs durent **10 secondes** parce que le mode dynamique de `loudnorm`
   * suit lentement : sur des blocs courts son gain n'a pas le temps de bouger et
   * les deux modes rendent le même fichier. C'est cette lenteur qu'on met en
   * évidence.
   */
  async function buildDynamicSource(path: string): Promise<void> {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=c=pink:a=1.0,alimiter=limit=0.25:level=disabled',
      '-t',
      String(DYNAMIC_SECONDS),
      '-af',
      `volume='if(lt(mod(t,${BLOCK_SECONDS * 2}),${BLOCK_SECONDS}),1,${QUIET_FACTOR})':eval=frame`,
      '-c:a',
      'pcm_s16le',
      path,
    ])
  }

  /**
   * L'écart de niveau **entre un bloc fort et un bloc faible** du même fichier.
   *
   * C'est la mesure qui tranche, et elle est plus directe que la plage globale :
   * un gain constant la laisse intacte, un gain qui suit le morceau la rabote.
   * Les deux secondes de marge écartent les transitions, où le filtre est en
   * train de bouger.
   */
  async function blockGap(path: string): Promise<number> {
    const loud = await ebur128(path, { from: 1, seconds: BLOCK_SECONDS - 2 })
    const quiet = await ebur128(path, { from: BLOCK_SECONDS + 1, seconds: BLOCK_SECONDS - 2 })
    return loud.i - quiet.i
  }

  group.setup(async () => {
    const dir = app.makePath('storage/test-sources')
    await mkdir(dir, { recursive: true })
    sourcePath = join(dir, `${ids.linear}.wav`)
    await buildDynamicSource(sourcePath)

    const transcoder = new FfmpegTranscoder()
    measured = await transcoder.measureLoudness(sourcePath)

    // La sortie **du régime réel** : deux passes, la mesure repassée au filtre.
    linearResult = await transcoder.encodeRadio(
      sourcePath,
      ids.linear,
      measured,
      DYNAMIC_SECONDS,
      () => {}
    )

    // Et la **contre-épreuve** : la même source, la même cible, mais sans mesure
    // préalable — donc le mode dynamique, c'est-à-dire exactement ce que le
    // second décodage achète. Sans elle, « la plage est préservée » pourrait être
    // vrai sans que le gain constant y soit pour quoi que ce soit.
    await transcoder.encodeRadio(sourcePath, ids.dynamique, null, DYNAMIC_SECONDS, () => {})

    return async () => {
      await rm(sourcePath, { force: true })
      for (const id of Object.values(ids)) {
        await rm(radioOutputDir(id), { recursive: true, force: true })
      }
    }
  })

  test('la source a une plage réelle, et remplit les conditions du mode linéaire', async ({
    assert,
  }) => {
    assert.isNotNull(measured, "la passe d'analyse n'a rien mesuré")

    // Sans plage, « préserver la dynamique » ne veut rien dire : c'est le reproche
    // fait au bruit rose nu, et cette assertion empêche la source de glisser vers
    // ce cas dégénéré sans qu'on s'en aperçoive.
    assert.isAbove(
      measured!.lra,
      4,
      `plage de la source ${measured!.lra} LU : trop plate pour prouver quoi que ce soit`
    )

    // Condition 1 : un gain constant ne réduit pas une plage.
    assert.isAtMost(
      measured!.lra,
      RADIO_LOUDNESS.targetLra,
      `plage ${measured!.lra} LU au-delà de la cible : loudnorm refusera le mode linéaire`
    )

    // Condition 2 : le gain ne doit pas faire dépasser le pic cible. C'est la
    // contrainte qui mord, et la marge est écrite pour qu'un futur réglage de la
    // source qui la mangerait se signale ici plutôt que par un test capricieux.
    const gain = RADIO_LOUDNESS.targetI - measured!.i
    const peakAfterGain = measured!.tp + gain
    assert.isBelow(
      peakAfterGain,
      RADIO_LOUDNESS.targetTp,
      `pic après gain ${peakAfterGain.toFixed(2)} dBTP : au-delà de la cible, loudnorm retombera en dynamique`
    )
  }).timeout(180_000)

  test('loudnorm applique bien un gain constant, et le dit', async ({ assert }) => {
    assert.isNotNull(linearResult.loudness, 'aucun niveau publié')

    // **L'assertion qui manquait.** Le champ vient du filtre lui-même, sur le
    // fichier qu'il vient d'écrire : c'est la seule preuve qu'un gain constant a
    // réellement été appliqué, et non pas seulement demandé dans la ligne de
    // commande.
    assert.equal(
      linearResult.loudness!.normalization,
      'linear',
      'loudnorm est retombé en mode dynamique : le second décodage ne sert alors à rien'
    )
  }).timeout(180_000)

  test('le gain constant préserve la dynamique, là où le mode dynamique la comprime', async ({
    assert,
  }) => {
    const sourceGap = await blockGap(sourcePath)
    const linearGap = await blockGap(radioTrackPath(ids.linear))
    const dynamicGap = await blockGap(radioTrackPath(ids.dynamique))

    // **C'est l'argument de qualité de l'ADR-0010, et le voici sur des octets.**
    // Le gain constant déplace le morceau en bloc : l'écart entre un passage fort
    // et un passage faible sort tel qu'il est entré.
    assert.closeTo(
      linearGap,
      sourceGap,
      1,
      `le gain constant a modifié la dynamique : source ${sourceGap} LU, sortie ${linearGap} LU`
    )

    // Et la contre-épreuve, qui donne son sens à l'assertion précédente : en une
    // passe, le gain suit le morceau, pousse les passages calmes et retient les
    // forts — l'écart se referme. Un titre sorti ainsi est au bon niveau **mais il
    // a été retouché à l'intérieur**.
    assert.isBelow(
      dynamicGap,
      sourceGap - 1.2,
      `le mode dynamique n'a rien comprimé (source ${sourceGap} LU, sortie ${dynamicGap} LU) : la source ne discrimine plus les deux régimes`
    )

    // Les deux modes doivent être séparés par une marge franche, sinon ce test ne
    // prouve rien de ce que la tranche a payé.
    assert.isAbove(
      linearGap - dynamicGap,
      1.2,
      `linéaire ${linearGap} LU et dynamique ${dynamicGap} LU trop proches`
    )
  }).timeout(180_000)

  test('et le niveau intégré atteint quand même la cible', async ({ assert }) => {
    // Préserver la dynamique ne dispense pas de faire le travail : la sortie doit
    // être au niveau de toutes les autres, sinon la tranche a échoué à son seul
    // objet.
    const out = await ebur128(radioTrackPath(ids.linear))
    assert.closeTo(
      out.i,
      RADIO_LOUDNESS.targetI,
      1.5,
      `${out.i} LUFS, cible ${RADIO_LOUDNESS.targetI}`
    )

    // Le niveau publié est bien celui du fichier, comme sur le groupe précédent.
    assert.closeTo(
      linearResult.loudness!.outputI,
      out.i,
      1,
      `niveau annoncé ${linearResult.loudness!.outputI}, mesuré ${out.i}`
    )
  }).timeout(180_000)
})
