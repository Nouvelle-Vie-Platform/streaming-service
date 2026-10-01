import { test } from '@japa/runner'
import {
  POSTER_FORMAT,
  PROFILE_SEGMENT_SECONDS,
  SPARKS_AUDIO_RENDITIONS,
  SPARKS_RENDITIONS,
  SPARKS_VIDEO,
  WAVEFORM_SAMPLE_RATE,
  outputPlaylistUrl,
  segmentSeconds,
  sparksAnalysisArgs,
  sparksOutputArgs,
  sparksPosterArgs,
  sparksPosterKey,
  sparksPosterPath,
  sparksPosterUrl,
} from '#transcodes/support/hls'
import type { LoudnessMeasurement } from '#transcodes/support/hls'
import { WAVEFORM_BARS, WAVEFORM_FLOOR_DB, waveformFromPcm } from '#transcodes/support/waveform'
import { DEFAULT_PROFILE, TRANSCODE_PROFILES } from '#transcodes/support/transcode_enums'

/** Une mesure plausible de passe 1, avec des valeurs distinctes et reconnaissables. */
const MEASURED: LoudnessMeasurement = {
  i: -24.5,
  tp: -2.25,
  lra: 6.75,
  thresh: -34.9,
  targetOffset: 0.21,
}

/** Du PCM mono 16 bits, une amplitude constante par tranche. */
function pcm(blocks: { amplitude: number; samples: number }[]): Buffer {
  const total = blocks.reduce((sum, block) => sum + block.samples, 0)
  const buffer = Buffer.alloc(total * 2)
  let at = 0
  for (const block of blocks) {
    for (let n = 0; n < block.samples; n += 1) {
      // Alterné, pour que l'efficace vaille l'amplitude et non zéro.
      buffer.writeInt16LE(Math.round(block.amplitude * (n % 2 === 0 ? 1 : -1)), at * 2)
      at += 1
    }
  }
  return buffer
}

test.group('le profil sparks existe des trois côtés (issue #49)', () => {
  test('il est accepté sans déloger le défaut', ({ assert }) => {
    // Le défaut reste porté par la base et par le code : un profil de plus n'a
    // aucune raison de changer ce qu'obtient une requête qui ne demande rien.
    assert.equal(DEFAULT_PROFILE, 'teaching')
    assert.include(TRANSCODE_PROFILES, 'sparks')
    assert.lengthOf(TRANSCODE_PROFILES, 3)
  })
})

test.group('la durée de segment est une propriété du profil (issue #49)', () => {
  test('chaque profil répond pour lui-même', ({ assert }) => {
    assert.equal(segmentSeconds('teaching'), 6)
    assert.equal(segmentSeconds('sparks'), 5)
    // `null`, et non `0` ou `6` : la radio ne segmente pas, sa sortie est un
    // fichier. Une valeur inutilisée aurait laissé croire le contraire.
    assert.isNull(segmentSeconds('radio'))
  })

  test('le régime historique ne bouge pas d’une seconde', ({ assert }) => {
    // Le garde-fou de la tranche : toucher à cette valeur changerait la forme de
    // tous les enseignements déjà transcodés, pour rien.
    assert.equal(PROFILE_SEGMENT_SECONDS.teaching, 6)
  })

  test('un profil nouveau ne compile pas sans répondre', ({ assert }) => {
    // `satisfies Record<TranscodeProfile, …>` ferme la table sur l'union : le
    // compilateur est le test, et celui-ci ne fait que le dire à voix haute.
    assert.sameMembers(Object.keys(PROFILE_SEGMENT_SECONDS), [...TRANSCODE_PROFILES])
  })
})

test.group('l’échelle à deux barreaux (issue #49)', () => {
  test('deux rendus, du plus pauvre au plus riche', ({ assert }) => {
    // Deux molettes distinctes : la durée de segment fixe le démarrage, le nombre
    // de rendus protège les réseaux faibles. Un seul débit sur un parc qui va de
    // la 4G à l'EDGE revient à choisir qui sera mal servi.
    assert.lengthOf(SPARKS_RENDITIONS, 2)
    assert.lengthOf(SPARKS_AUDIO_RENDITIONS, 2)
    assert.deepEqual(
      SPARKS_RENDITIONS.map((rendition) => rendition.name),
      ['low', 'high']
    )
    assert.isBelow(SPARKS_RENDITIONS[0].width, SPARKS_RENDITIONS[1].width)
  })

  test('le codec est celui que les téléphones décodent en matériel', ({ assert }) => {
    assert.equal(SPARKS_VIDEO.codec, 'libx264')
    assert.equal(SPARKS_VIDEO.pixelFormat, 'yuv420p')
    // `high` ou `yuv444p` joueraient sur le poste de développement et se
    // décoderaient en logiciel sur le téléphone de l'auditeur.
    assert.equal(SPARKS_VIDEO.profile, 'main')
  })
})

test.group('arguments ffmpeg du profil sparks (issue #49)', () => {
  test('la passe d’analyse n’encode rien et rend deux sous-produits', ({ assert }) => {
    const args = sparksAnalysisArgs('/tmp/source.mp4')
    const graph = args[args.indexOf('-filter_complex') + 1]

    // Une seule lecture, deux branches : la mesure se jette dans le vide, la
    // forme d'onde sort en PCM réduit sur le tuyau.
    assert.include(graph, 'asplit=2')
    assert.include(graph, 'loudnorm=')
    assert.include(graph, `aresample=${WAVEFORM_SAMPLE_RATE}`)
    assert.deepEqual(args.slice(-12), [
      '-map',
      '[lnorm]',
      '-f',
      'null',
      '-',
      '-map',
      '[pcm]',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ])

    // Pas de `linear=true` sans mesure : le réclamer sans `measured_*` ferait
    // retomber ffmpeg en dynamique sans le dire.
    assert.notInclude(graph, 'linear=true')
  })

  test('⚠️ une image-clé est forcée sur chaque frontière de segment', ({ assert }) => {
    const args = sparksOutputArgs('abc-123', MEASURED, true)
    const at = args.indexOf('-force_key_frames')

    // **Le piège central de la tranche.** `-hls_time` ne découpe pas, il demande
    // à découper : le muxeur attend une image-clé. Sans contrainte, x264 en pose
    // une toutes les 250 images — 8,33 s à 30 i/s — et les segments sortent à
    // 8,33 s sur un réglage de 5. Mesuré au banc, et rien ne le signalait.
    assert.isAbove(at, -1, '-force_key_frames absent : les segments dériveront')
    assert.equal(args[at + 1], `expr:gte(t,n_forced*${PROFILE_SEGMENT_SECONDS.sparks})`)

    // Et la playlist doit le dire au lecteur, sinon il n'ose pas démarrer ailleurs
    // qu'au début.
    assert.equal(args[args.indexOf('-hls_flags') + 1], 'independent_segments')
    assert.equal(args[args.indexOf('-hls_time') + 1], '5')
  })

  test('la sortie vidéo mappe deux couples image+son et les nomme', ({ assert }) => {
    const args = sparksOutputArgs('abc-123', MEASURED, true)
    const graph = args[args.indexOf('-filter_complex') + 1]

    assert.include(graph, 'split=2')
    for (const rendition of SPARKS_RENDITIONS) {
      assert.include(graph, `[v_${rendition.name}]`)
      assert.include(graph, `[a_${rendition.name}]`)
      // Jamais d'agrandissement : une source déjà plus petite passe telle quelle.
      assert.include(graph, `min(${rendition.width},iw)`)
    }

    assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0,a:0,name:low v:1,a:1,name:high')
    assert.equal(args[args.length - 1].endsWith('%v/index.m3u8'), true)
  })

  test('⚠️ la fréquence est forcée, sinon loudnorm sort en 192 kHz', ({ assert }) => {
    const graph = sparksOutputArgs('abc-123', MEASURED, true)[1]
    // La panne de la radio, et elle ne ressemble pas à une panne : sans
    // ré-échantillonnage l'encodeur AAC écrit du 96 kHz — son plafond — et le
    // fichier joue quand même.
    assert.match(graph, /loudnorm=[^;\[]*,aresample=48000,/)
  })

  test('la mesure est repassée au filtre, et c’est le gain constant', ({ assert }) => {
    const graph = sparksOutputArgs('abc-123', MEASURED, true)[1]
    assert.include(graph, `measured_I=${MEASURED.i}`)
    assert.include(graph, `measured_TP=${MEASURED.tp}`)
    assert.include(graph, `measured_thresh=${MEASURED.thresh}`)
    assert.include(graph, 'linear=true')
  })

  test('sans mesure, la passe retombe en dynamique plutôt que d’échouer', ({ assert }) => {
    const graph = sparksOutputArgs('abc-123', null, true)[1]
    assert.notInclude(graph, 'measured_')
    assert.notInclude(graph, 'linear=true')
  })

  test('un Spark sonore garde deux rendus, et n’encode aucune image', ({ assert }) => {
    const args = sparksOutputArgs('abc-123', MEASURED, false)
    const graph = args[args.indexOf('-filter_complex') + 1]

    // « Au plus un média temporel, audio **ou** vidéo » : l'audio seul est un cas
    // normal, pas une dégradation.
    assert.notInclude(graph, 'split=2;')
    assert.notInclude(graph, 'scale=')
    assert.notInclude(args, '-c:v')
    assert.notInclude(args, '-force_key_frames')
    assert.equal(args[args.indexOf('-var_stream_map') + 1], 'a:0,name:low a:1,name:high')

    // Et les débits sont ceux de l'échelle sonore : sans vidéo à financer, il n'y
    // a aucune raison de rogner sur le son du barreau haut.
    assert.equal(args[args.indexOf('-b:a:1') + 1], '128k')
  })
})

test.group('la vignette (issue #49)', () => {
  test('elle vit dans le dossier HLS, donc elle part avec lui', ({ assert }) => {
    // C'est ce qui lui épargne un préfixe public, un bloc Caddy et une branche de
    // reprise — trois endroits où un oubli rend 403 ou 404 sans dire pourquoi.
    assert.isTrue(sparksPosterPath('abc-123').endsWith('/hls/abc-123/poster.jpg'))
    assert.equal(sparksPosterKey('abc-123'), 'hls/abc-123/poster.jpg')
  })

  test('son URL est absolue et partage l’origine de la playlist', ({ assert }) => {
    const origin = (u: string) => u.slice(0, u.indexOf('/', 'https://'.length))
    assert.equal(origin(sparksPosterUrl('abc-123')), origin(outputPlaylistUrl('abc-123')))
    assert.notInclude(sparksPosterUrl('abc-123'), '?')
  })

  test('le prélèvement cherche un peu après le début', ({ assert }) => {
    const args = sparksPosterArgs('/tmp/source.mp4', 'abc-123', 2.5)
    // `-ss` **avant** `-i` : le décodeur saute au lieu de décoder puis de jeter.
    assert.isBelow(args.indexOf('-ss'), args.indexOf('-i'))
    assert.equal(args[args.indexOf('-ss') + 1], '2.500')
    assert.equal(args[args.indexOf('-frames:v') + 1], '1')
    assert.equal(args[args.indexOf('-f') + 1], POSTER_FORMAT.container)
    assert.equal(args[args.length - 1], sparksPosterPath('abc-123'))
  })
})

test.group('la forme d’onde (issue #49)', () => {
  test('trente-six hauteurs entières, bornées à 0 et 100', ({ assert }) => {
    const heights = waveformFromPcm(pcm([{ amplitude: 8000, samples: 36_000 }]))
    assert.isNotNull(heights)
    assert.lengthOf(heights!, WAVEFORM_BARS)
    for (const height of heights!) {
      assert.isTrue(Number.isInteger(height), `${height} n'est pas un entier`)
      assert.isAtLeast(height, 0)
      assert.isAtMost(height, 100)
    }
  })

  test('⚠️ un silence au début se lit comme un silence', ({ assert }) => {
    // **C'est tout l'objet du champ.** Le client sait déjà se replier sur un
    // hachage déterministe, mais ce repli dessine des collines là où le Spark se
    // tait : l'auditeur voit une barre haute et croit que la lecture a démarré.
    const heights = waveformFromPcm(
      pcm([
        { amplitude: 0, samples: 12_000 },
        { amplitude: 12_000, samples: 24_000 },
      ])
    )!

    assert.equal(heights[0], 0)
    assert.equal(heights[11], 0, 'le premier tiers doit être muet')
    assert.isAbove(heights[20], 90, 'le reste doit être plein')
  })

  test('la barre la plus forte vaut 100', ({ assert }) => {
    const heights = waveformFromPcm(
      pcm([
        { amplitude: 1000, samples: 18_000 },
        { amplitude: 20_000, samples: 18_000 },
      ])
    )!
    assert.equal(Math.max(...heights), 100)
    // Et le passage faible reste **visible** : l'échelle est en décibels, pas en
    // amplitude — en linéaire il sortirait à 5 sur 100, c'est-à-dire invisible.
    assert.isAbove(heights[0], 20)
  })

  test('un fichier muet rend trente-six zéros, et non une absence', ({ assert }) => {
    const heights = waveformFromPcm(pcm([{ amplitude: 0, samples: 36_000 }]))
    assert.isNotNull(heights, 'un silence est une mesure, pas un échec')
    assert.deepEqual(heights, new Array(WAVEFORM_BARS).fill(0))
  })

  test('trop peu d’échantillons rend null plutôt qu’une barre inventée', ({ assert }) => {
    assert.isNull(waveformFromPcm(pcm([{ amplitude: 9000, samples: 10 }])))
    assert.isNull(waveformFromPcm(Buffer.alloc(0)))
  })

  test('le plancher est franc et documenté', ({ assert }) => {
    // -48 dB plutôt que -60 : en dessous on remonte le bruit de fond d'un
    // enregistrement au téléphone, et le silence cesse de se lire comme un silence.
    assert.equal(WAVEFORM_FLOOR_DB, -48)
  })
})
