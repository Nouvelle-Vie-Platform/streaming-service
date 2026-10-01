import { test } from '@japa/runner'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import {
  LOUDNESS_TARGET,
  PROFILE_SEGMENT_SECONDS,
  SPARKS_RENDITIONS,
  archivePath,
  downloadOutputDir,
  hlsOutputDir,
  sparksOutputArgs,
  sparksPosterPath,
} from '#transcodes/support/hls'
import { WAVEFORM_BARS } from '#transcodes/support/waveform'
import app from '@adonisjs/core/services/app'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** La durée de segment du profil, lue à la source plutôt que recopiée. */
const SEGMENT = PROFILE_SEGMENT_SECONDS.sparks

/**
 * Quarante secondes : huit segments pleins, assez pour que la dérive des
 * images-clés se voie et pour que la loudness intégrée d'EBU R128 se prononce.
 */
const DURATION = 40

/** Quatre blocs de dix secondes — fort, faible, fort, faible. */
const BLOCK = 10

/** Trente images par seconde : la cadence d'un téléphone. */
const FPS = 30

/**
 * **La source du banc, et chacune de ses contraintes a été payée.**
 *
 * - Du **bruit rose passé au limiteur** : nu, son facteur de crête est déjà à la
 *   limite (≈ 14,3 LU) et creuser des blocs faibles l'y pousse au-delà, ce qui
 *   ferme le mode `linear`. Le limiteur le ramène vers 12 LU — et c'est aussi ce
 *   à quoi ressemble un enregistrement traité.
 * - Des blocs de **10 s à ≈ 8 LU d'écart** : assez pour une vraie plage (sinon
 *   « préserver la dynamique » ne veut rien dire), assez peu pour rester sous la
 *   plage cible de 11 LU, et assez longs pour que le mode dynamique ait le temps
 *   de bouger son gain.
 * - Une **image** à 30 i/s : c'est la cadence qui rend la dérive des images-clés
 *   visible. x264 pose une image-clé toutes les 250 images par défaut, soit
 *   8,33 s — un chiffre qui ne ressemble pas à 5 et qu'on ne peut pas confondre.
 */
async function buildAudioVideoSource(path: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostats',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=${FPS}:duration=${DURATION}`,
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=c=pink:a=1.0,alimiter=limit=0.25:level=disabled',
    '-t',
    String(DURATION),
    '-af',
    `volume='if(lt(mod(t,${BLOCK * 2}),${BLOCK}),1,0.4)':eval=frame`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    '-f',
    'matroska',
    path,
  ])
}

/** Un Spark **sonore** : la seconde moitié du « au plus un média temporel ». */
async function buildAudioSource(path: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostats',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=c=pink:a=0.3',
    '-t',
    '12',
    '-c:a',
    'pcm_s16le',
    path,
  ])
}

/** Une source qui **commence par un silence** — le cas qui démasque le repli. */
async function buildSilentHeadSource(path: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-y',
    '-nostats',
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=c=pink:a=0.4',
    '-t',
    '18',
    '-af',
    "volume='if(lt(t,6),0,1)':eval=frame",
    '-c:a',
    'pcm_s16le',
    path,
  ])
}

/**
 * Le résumé d'`ebur128` — ou d'une **tranche** —, **mesuré par un autre chemin
 * que celui qu'on teste**.
 *
 * `loudnorm` publie ses propres chiffres ; les vérifier avec `loudnorm` serait
 * demander au témoin de confirmer son témoignage. `ebur128` est l'autre filtre
 * d'ffmpeg, indépendant, et c'est lui qui tranche ici. Il lit directement la
 * playlist HLS produite, donc il mesure **les octets servis**, pas une étape
 * intermédiaire.
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
  const i = /I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(stderr)
  const lra = /LRA:\s+(-?\d+(?:\.\d+)?) LU/.exec(stderr)
  if (!i || !lra) throw new Error(`ebur128 n'a rien dit de lisible :\n${stderr.slice(-1500)}`)
  return { i: Number(i[1]), lra: Number(lra[1]) }
}

/** L'écart de niveau entre un bloc fort et un bloc faible du même média. */
async function blockGap(path: string): Promise<number> {
  const loud = await ebur128(path, { from: 1, seconds: BLOCK - 2 })
  const quiet = await ebur128(path, { from: BLOCK + 1, seconds: BLOCK - 2 })
  return loud.i - quiet.i
}

/** Les durées annoncées par une playlist de rendu, dans l'ordre. */
function segmentDurations(playlist: string): number[] {
  return [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1]))
}

/**
 * Si la **première image** d'un segment est une image-clé — donc si ce segment se
 * décode sans le précédent.
 *
 * `-read_intervals %+#1` arrête la sonde à la première image : on lit le début du
 * fichier, pas tout le fichier.
 */
async function firstFrameIsKeyframe(path: string): Promise<boolean> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-read_intervals',
    '%+#1',
    '-show_entries',
    'frame=key_frame',
    '-of',
    'csv=p=0',
    path,
  ])
  return stdout.trim().split('\n')[0]?.replace(/,$/, '') === '1'
}

/** Un champ de la sonde sur la première piste d'un type donné. */
async function probeField(path: string, select: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    select,
    '-show_entries',
    entry,
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  return stdout.trim().split('\n')[0] ?? ''
}

/**
 * **Le banc du profil `sparks`** (issue #49) — une vraie passe ffmpeg, et des
 * vérifications faites par d'autres outils que celui qu'on teste.
 *
 * Il est écrit sur le modèle de `radio_normalisation.spec.ts`, et il en reprend
 * les deux disciplines qui ont fait sa valeur : **vérifier avec un filtre
 * indépendant**, et **éprouver par mutation** — retirer la mesure préalable, ou
 * retirer la contrainte d'images-clés, doit faire tomber des assertions. Un banc
 * dont les contre-épreuves passent aussi ne prouve rien.
 */
test.group('profil sparks — vidéo, segments de 5 s, images-clés (issue #49)', (group) => {
  const ids = {
    video: `test-sparks-video-${Date.now()}`,
    libre: `test-sparks-libre-${Date.now()}`,
    sansMesure: `test-sparks-sans-mesure-${Date.now()}`,
    audio: `test-sparks-audio-${Date.now()}`,
    silence: `test-sparks-silence-${Date.now()}`,
  }
  const sources: Record<string, string> = {}
  const transcoder = new FfmpegTranscoder()

  let analysis: Awaited<ReturnType<FfmpegTranscoder['analyseSparks']>>
  let loudness: Awaited<ReturnType<FfmpegTranscoder['encodeSparks']>>
  let posterWritten = false

  group.setup(async () => {
    const dir = app.makePath('storage/test-sources')
    await mkdir(dir, { recursive: true })

    sources.video = join(dir, `${ids.video}.mkv`)
    sources.audio = join(dir, `${ids.audio}.wav`)
    sources.silence = join(dir, `${ids.silence}.wav`)
    await buildAudioVideoSource(sources.video)
    await buildAudioSource(sources.audio)
    await buildSilentHeadSource(sources.silence)

    // Le régime réel : mesurer, puis appliquer.
    analysis = await transcoder.analyseSparks(sources.video)
    loudness = await transcoder.encodeSparks(
      sources.video,
      ids.video,
      analysis.measured,
      true,
      DURATION,
      () => {}
    )
    posterWritten = await transcoder.extractPoster(sources.video, ids.video, DURATION)

    // **Contre-épreuve 1** — la même passe sans la mesure préalable, donc sans
    // gain constant. C'est exactement ce que le second décodage achète.
    await transcoder.encodeSparks(sources.video, ids.sansMesure, null, true, DURATION, () => {})

    // **Contre-épreuve 2** — la même passe, mesure comprise, mais **sans la
    // contrainte d'images-clés**. C'est le piège central de la tranche, et il
    // faut qu'on le voie tomber.
    await encodeWithoutForcedKeyframes(sources.video, ids.libre, analysis.measured)

    // Le Spark sonore : deux rendus, aucune image.
    await transcoder.encodeSparks(sources.audio, ids.audio, null, false, 12, () => {})

    return async () => {
      for (const path of Object.values(sources)) await rm(path, { force: true })
      for (const id of Object.values(ids)) {
        await rm(hlsOutputDir(id), { recursive: true, force: true })
        await rm(downloadOutputDir(id), { recursive: true, force: true })
      }
    }
  })

  /**
   * La passe réelle **moins `-force_key_frames`**, et rien d'autre.
   *
   * Les arguments sont tirés de `sparksOutputArgs` plutôt que réécrits : une
   * contre-épreuve qui recopierait la commande dériverait de l'originale, et
   * cesserait de contredire quoi que ce soit le jour où celle-ci change.
   */
  async function encodeWithoutForcedKeyframes(
    source: string,
    id: string,
    measured: Awaited<ReturnType<FfmpegTranscoder['analyseSparks']>>['measured']
  ): Promise<void> {
    for (const rendition of SPARKS_RENDITIONS) {
      await mkdir(join(hlsOutputDir(id), rendition.name), { recursive: true })
    }

    const full = sparksOutputArgs(id, measured, true)
    const at = full.indexOf('-force_key_frames')
    if (at < 0) {
      // Si la passe réelle ne force plus d'images-clés, il n'y a plus rien à
      // muter — et c'est la passe réelle qui est en faute, pas la contre-épreuve.
      throw new Error(
        "la passe réelle ne force plus d'images-clés : la contre-épreuve n'a plus de sens"
      )
    }
    const mutated = [...full.slice(0, at), ...full.slice(at + 2)]

    await execFileAsync('ffmpeg', ['-hide_banner', '-y', '-i', source, '-nostats', ...mutated], {
      maxBuffer: 16 * 1024 * 1024,
    })
  }

  test('les segments durent exactement 5 s, et le dernier seul est plus court', async ({
    assert,
  }) => {
    for (const rendition of SPARKS_RENDITIONS) {
      const playlist = await readFile(
        join(hlsOutputDir(ids.video), rendition.name, 'index.m3u8'),
        'utf8'
      )
      const durations = segmentDurations(playlist)
      assert.isAbove(durations.length, 1, `${rendition.name} : un seul segment`)

      for (const duration of durations.slice(0, -1)) {
        assert.closeTo(
          duration,
          SEGMENT,
          0.1,
          `${rendition.name} : segment de ${duration} s au lieu de ${SEGMENT}`
        )
      }
      assert.isAtMost(durations[durations.length - 1], SEGMENT + 0.1)
    }
  }).timeout(240_000)

  test('⚠️ chaque segment commence par une image-clé, donc se décode seul', async ({ assert }) => {
    // **Sans cela, un segment de 5 s n'est pas décodable seul et le démarrage
    // rapide qu'on cherche disparaît.** C'est la raison d'être de la durée de
    // segment : si le lecteur doit remonter au segment précédent pour trouver une
    // image de référence, il télécharge deux segments avant d'afficher quoi que
    // ce soit.
    const dir = join(hlsOutputDir(ids.video), 'high')
    const playlist = await readFile(join(dir, 'index.m3u8'), 'utf8')
    const segments = [...playlist.matchAll(/^(seg_\d+\.ts)$/gm)].map((match) => match[1])
    assert.isAbove(segments.length, 1)

    for (const segment of segments) {
      assert.isTrue(
        await firstFrameIsKeyframe(join(dir, segment)),
        `${segment} ne commence pas par une image-clé : il ne se décode pas seul`
      )
    }
  }).timeout(240_000)

  test('⚠️ la contre-épreuve : sans images-clés forcées, les segments dérivent', async ({
    assert,
  }) => {
    // **Le test qui donne son sens au précédent.** `-hls_time` ne découpe pas, il
    // *demande* à découper : le muxeur attend une image-clé. x264 en pose une
    // toutes les 250 images par défaut — 8,33 s à 30 i/s. La playlist reste
    // valide, la vidéo joue, et le réglage de 5 s n'a servi à rien.
    const playlist = await readFile(join(hlsOutputDir(ids.libre), 'high', 'index.m3u8'), 'utf8')
    const durations = segmentDurations(playlist).slice(0, -1)

    assert.isAbove(durations.length, 0, 'la contre-épreuve n’a produit qu’un segment')
    const drifting = durations.filter((duration) => Math.abs(duration - SEGMENT) > 0.5)
    assert.isAbove(
      drifting.length,
      0,
      `sans contrainte, les segments sortent déjà à ${SEGMENT} s : la contre-épreuve ne contredit plus rien (${durations.join(', ')})`
    )
  }).timeout(240_000)

  test('le master liste deux rendus, de résolutions et de débits distincts', async ({ assert }) => {
    const master = await readFile(join(hlsOutputDir(ids.video), 'master.m3u8'), 'utf8')
    const variants = [...master.matchAll(/#EXT-X-STREAM-INF:([^\n]+)/g)].map((match) => match[1])

    // Deux molettes distinctes : les segments courts règlent le démarrage, les
    // deux rendus protègent les réseaux faibles.
    assert.lengthOf(variants, SPARKS_RENDITIONS.length)

    const resolutions = variants.map((line) => /RESOLUTION=(\d+)x(\d+)/.exec(line))
    assert.isTrue(
      resolutions.every((match) => match !== null),
      'un rendu sans résolution : le lecteur ne saura pas choisir'
    )
    const widths = resolutions.map((match) => Number(match![1]))
    assert.deepEqual(
      [...widths].sort((a, b) => a - b),
      widths,
      'les rendus ne sont pas ordonnés'
    )
    assert.notEqual(widths[0], widths[1], 'les deux rendus ont la même résolution')

    const bandwidths = variants.map((line) => Number(/BANDWIDTH=(\d+)/.exec(line)![1]))
    assert.isBelow(bandwidths[0], bandwidths[1])
    // Le barreau bas doit vraiment être bas : c'est lui qui sert une branche mal
    // desservie, et un « bas » à 1 Mbps ne servirait personne.
    assert.isBelow(bandwidths[0], 800_000, `barreau bas à ${bandwidths[0]} bps : trop lourd`)

    for (const rendition of SPARKS_RENDITIONS) {
      assert.isTrue(master.includes(`${rendition.name}/index.m3u8`))
    }
  })

  test('la playlist annonce des segments indépendants', async ({ assert }) => {
    const playlist = await readFile(join(hlsOutputDir(ids.video), 'low', 'index.m3u8'), 'utf8')
    // Sans ce marqueur, un lecteur n'ose pas démarrer ailleurs qu'au début —
    // les images-clés seraient alignées pour rien.
    assert.include(playlist, '#EXT-X-INDEPENDENT-SEGMENTS')
    assert.include(playlist, '#EXT-X-PLAYLIST-TYPE:VOD')
  })

  test('le niveau est bien à la cible, mesuré par un filtre indépendant', async ({ assert }) => {
    const out = await ebur128(join(hlsOutputDir(ids.video), 'high', 'index.m3u8'))
    assert.closeTo(
      out.i,
      LOUDNESS_TARGET.targetI,
      1.5,
      `${out.i} LUFS, cible ${LOUDNESS_TARGET.targetI}`
    )

    // Le niveau **publié** est celui des octets servis, et non une prédiction :
    // c'est cette égalité qui autorise le portail à s'y fier sans remesurer.
    assert.isNotNull(loudness, 'aucun niveau publié')
    assert.closeTo(
      loudness!.outputI,
      out.i,
      1,
      `niveau annoncé ${loudness!.outputI}, mesuré ${out.i}`
    )
  }).timeout(240_000)

  test('⚠️ le mode de normalisation est exposé, et il n’est pas garanti', async ({ assert }) => {
    assert.isNotNull(analysis.measured, "la passe d'analyse n'a rien mesuré")
    assert.isNotNull(loudness, 'aucun niveau publié')

    // **`linear` est une propriété de la source, pas du code.** `loudnorm` refuse
    // le gain constant à deux conditions : la plage mesurée doit tenir sous la
    // plage cible, et le pic après gain sous le pic cible — ce qui se réduit à
    // `TP − I ≤ 14,5 LU`, le facteur de crête. Le banc vérifie donc la
    // **cohérence** entre la condition et le mode annoncé, et non que le mode
    // vaut `linear` par décret.
    const { i, tp, lra } = analysis.measured!
    const crest = tp - i
    const gain = LOUDNESS_TARGET.targetI - i
    const eligible = lra <= LOUDNESS_TARGET.targetLra && tp + gain <= LOUDNESS_TARGET.targetTp

    assert.oneOf(loudness!.normalization, ['linear', 'dynamic'])
    assert.equal(
      loudness!.normalization,
      eligible ? 'linear' : 'dynamic',
      `facteur de crête ${crest.toFixed(2)} LU, plage ${lra} LU : le mode annoncé (${loudness!.normalization}) contredit les conditions de loudnorm`
    )

    // Et la source du banc est taillée pour remplir les conditions : si elle
    // dérivait, l'assertion suivante tomberait avant que « le gain constant
    // préserve la dynamique » devienne vide de sens.
    assert.isTrue(
      eligible,
      `la source du banc ne qualifie plus pour le mode linéaire (crête ${crest.toFixed(2)} LU, plage ${lra} LU)`
    )
  }).timeout(240_000)

  test('⚠️ la contre-épreuve : sans mesure préalable, la dynamique est rabotée', async ({
    assert,
  }) => {
    const sourceGap = await blockGap(sources.video)
    const linearGap = await blockGap(join(hlsOutputDir(ids.video), 'high', 'index.m3u8'))
    const dynamicGap = await blockGap(join(hlsOutputDir(ids.sansMesure), 'high', 'index.m3u8'))

    // Le gain constant déplace le média en bloc : l'écart entre un passage fort
    // et un passage faible sort tel qu'il est entré.
    assert.closeTo(
      linearGap,
      sourceGap,
      1,
      `le gain constant a modifié la dynamique : source ${sourceGap} LU, sortie ${linearGap} LU`
    )

    // Et la passe unique le referme — c'est ce que le second décodage achète.
    assert.isBelow(
      dynamicGap,
      sourceGap - 1,
      `le mode dynamique n'a rien comprimé (source ${sourceGap} LU, sortie ${dynamicGap} LU) : la source ne discrimine plus les deux régimes`
    )
  }).timeout(240_000)

  test('la forme d’onde sort de la passe d’analyse, en trente-six hauteurs', async ({ assert }) => {
    assert.isNotNull(analysis.waveform, 'aucune forme d’onde')
    assert.lengthOf(analysis.waveform!, WAVEFORM_BARS)
    for (const height of analysis.waveform!) {
      assert.isTrue(Number.isInteger(height))
      assert.isAtLeast(height, 0)
      assert.isAtMost(height, 100)
    }
  })

  test('⚠️ un Spark qui commence par un silence le montre', async ({ assert }) => {
    // **Le repli par hachage du client « ment » exactement ici** : il dessinerait
    // des collines sur les six premières secondes, et l'auditeur croirait que la
    // lecture a démarré alors que rien ne joue encore. C'est le cas qui justifie
    // de dépenser un tuyau de PCM dans la passe d'analyse.
    const silent = await new FfmpegTranscoder().analyseSparks(sources.silence)
    assert.isNotNull(silent.waveform)

    // Les six premières des dix-huit secondes sont muettes : le premier tiers des
    // barres doit l'être aussi.
    const head = silent.waveform!.slice(0, 10)
    const tail = silent.waveform!.slice(16)
    assert.equal(Math.max(...head), 0, `début non muet : ${head.join(', ')}`)
    assert.isAbove(Math.min(...tail), 0, `fin muette : ${tail.join(', ')}`)
  }).timeout(120_000)

  test('la vignette est extraite, et elle part avec le jeu HLS', async ({ assert }) => {
    assert.isTrue(posterWritten, 'aucune vignette produite')
    const path = sparksPosterPath(ids.video)
    assert.isTrue(existsSync(path))

    // Dans le dossier HLS : c'est ce qui lui épargne un préfixe public, un bloc
    // Caddy et une branche de reprise.
    assert.isTrue(path.startsWith(hlsOutputDir(ids.video)))

    // Un vrai JPEG, pas un fichier vide qu'un `existsSync` prendrait pour un
    // succès : les deux premiers octets d'un JPEG sont `FF D8`.
    const bytes = readFileSync(path)
    assert.isAbove(bytes.length, 1000, 'vignette suspecte')
    assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8])

    const width = Number(await probeField(path, 'v:0', 'stream=width'))
    assert.isAtMost(width, SPARKS_RENDITIONS[SPARKS_RENDITIONS.length - 1].width)
  }).timeout(120_000)

  test('un Spark sonore garde deux rendus et n’a pas de vignette', async ({ assert }) => {
    const master = await readFile(join(hlsOutputDir(ids.audio), 'master.m3u8'), 'utf8')
    const variants = [...master.matchAll(/#EXT-X-STREAM-INF:/g)]
    assert.lengthOf(variants, 2)

    // Aucune piste vidéo dans les segments : « au plus un média temporel ».
    const segment = join(hlsOutputDir(ids.audio), 'low', 'seg_000.ts')
    assert.isTrue(existsSync(segment))
    assert.equal(await probeField(segment, 'v', 'stream=codec_type'), '')

    // Et pas de poster : `null` dit cela mieux qu'un carré noir.
    assert.isFalse(existsSync(sparksPosterPath(ids.audio)))
  }).timeout(120_000)

  test('le profil ne produit ni rendus progressifs, ni archive FLAC', async ({ assert }) => {
    // Le périmètre, en assertions négatives. Un Spark n'a pas de client hors
    // ligne à servir, et son master reste l'objet de l'appelant (ADR-0007).
    assert.isFalse(existsSync(downloadOutputDir(ids.video)), 'des rendus progressifs')
    assert.isFalse(existsSync(archivePath(ids.video)), 'une archive FLAC')
  })

  test('la sonde distingue une vraie piste vidéo d’une jaquette', async ({ assert }) => {
    const video = await transcoder.probe(sources.video)
    assert.isTrue(video.hasAudio)
    assert.isTrue(video.hasVideo)

    const audio = await transcoder.probe(sources.audio)
    assert.isTrue(audio.hasAudio)
    // ⚠️ Un MP3 à jaquette expose un flux `video` : l'encoder produirait un Spark
    // « vidéo » d'une seule image fixe. `attached_pic` les sépare, et c'est ce que
    // la sonde demande désormais.
    assert.isFalse(audio.hasVideo)
  }).timeout(60_000)
})
