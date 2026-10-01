import { test } from '@japa/runner'
import {
  RADIO_FORMAT,
  RADIO_LOUDNESS,
  loudnormFilter,
  outputPlaylistUrl,
  radioAnalysisArgs,
  radioKeyPrefix,
  radioOutputArgs,
  radioTrackKey,
  radioTrackPath,
  radioTrackUrl,
} from '#transcodes/support/hls'
import type { LoudnessMeasurement } from '#transcodes/support/hls'
import { readTags } from '#transcodes/support/media_tags'
import { DEFAULT_PROFILE, TRANSCODE_PROFILES } from '#transcodes/support/transcode_enums'

/** Une mesure plausible de passe 1, avec des valeurs distinctes et reconnaissables. */
const MEASURED: LoudnessMeasurement = {
  i: -27.5,
  tp: -3.25,
  lra: 4.75,
  thresh: -37.9,
  targetOffset: 0.15,
}

test.group('profil de transcodage (issue #46)', () => {
  test('le défaut est le régime historique', ({ assert }) => {
    // Une requête qui ne dit rien, et une ligne écrite avant que la colonne
    // existe, doivent obtenir exactement ce qu'elles obtenaient avant.
    assert.equal(DEFAULT_PROFILE, 'teaching')
    assert.include(TRANSCODE_PROFILES, 'teaching')
    assert.include(TRANSCODE_PROFILES, 'radio')
    // Le compte bouge quand un profil naît, et c'est voulu : un profil qui
    // s'ajoute sans passer par ici est un profil que la validation refuse.
    // `sparks` est arrivé par l'issue #49.
    assert.lengthOf(TRANSCODE_PROFILES, 3)
  })
})

test.group('clés et URL de la piste radio (issue #46)', () => {
  test('le préfixe verse la piste sous son identifiant de transcodage', ({ assert }) => {
    // L'`<id>` dans le chemin fait de chaque ré-encodage une nouvelle URL : une
    // antenne qui a mis un titre en cache ne peut pas récupérer les octets d'une
    // autre version sous la même adresse.
    assert.equal(radioKeyPrefix('abc-123'), 'radio/abc-123')
    assert.equal(radioTrackKey('abc-123'), 'radio/abc-123/track.m4a')
  })

  test("l'URL publique est absolue, non signée, et sous le préfixe", ({ assert }) => {
    const url = radioTrackUrl('abc-123')
    assert.match(url, /^https?:\/\//)
    assert.isTrue(url.endsWith(`/${radioTrackKey('abc-123')}`))
    // Pas de query string : une URL signée expirerait **en pleine diffusion**,
    // et l'antenne se tairait au milieu d'un titre.
    assert.notInclude(url, '?')
    assert.notInclude(url.replace(/^https?:\/\//, ''), '//')
  })

  test("l'URL radio partage l'origine publique du HLS", ({ assert }) => {
    const origin = (u: string) => u.slice(0, u.indexOf('/', 'https://'.length))
    assert.equal(origin(radioTrackUrl('abc-123')), origin(outputPlaylistUrl('abc-123')))
  })

  test('le chemin local vit hors des dossiers HLS et de téléchargement', ({ assert }) => {
    const path = radioTrackPath('abc-123')
    assert.isTrue(path.endsWith('/radio/abc-123/track.m4a'))
    // Chaque dossier est poussé en entier sous son propre préfixe : un fichier
    // égaré dans le mauvais dossier partirait avec la mauvaise clé et le mauvais
    // content-type.
    assert.notInclude(path, '/hls/')
    assert.notInclude(path, '/dl/abc-123')
  })
})

test.group('filtre loudnorm (issue #46)', () => {
  test('sans mesure, il reste en normalisation dynamique', ({ assert }) => {
    const filter = loudnormFilter(null)
    assert.include(filter, `I=${RADIO_LOUDNESS.targetI}`)
    assert.include(filter, `TP=${RADIO_LOUDNESS.targetTp}`)
    assert.include(filter, `LRA=${RADIO_LOUDNESS.targetLra}`)
    assert.include(filter, 'print_format=json')
    // Pas de `linear=true` sans mesure : le réclamer sans `measured_*` ferait
    // silencieusement retomber ffmpeg en dynamique, et on croirait appliquer un
    // gain constant.
    assert.notInclude(filter, 'linear')
    assert.notInclude(filter, 'measured_')
  })

  test('avec la mesure, il applique un gain constant', ({ assert }) => {
    const filter = loudnormFilter(MEASURED)
    assert.include(filter, `measured_I=${MEASURED.i}`)
    assert.include(filter, `measured_TP=${MEASURED.tp}`)
    assert.include(filter, `measured_LRA=${MEASURED.lra}`)
    assert.include(filter, `measured_thresh=${MEASURED.thresh}`)
    assert.include(filter, `offset=${MEASURED.targetOffset}`)
    // C'est tout l'objet du double décodage : `linear` = un gain décidé une
    // fois, donc les dynamiques du titre intactes.
    assert.include(filter, 'linear=true')
  })
})

test.group('arguments ffmpeg du profil radio (issue #46)', () => {
  test("la passe d'analyse n'encode rien", ({ assert }) => {
    const args = radioAnalysisArgs('/tmp/source.wav')
    // Le coût de la seconde lecture est un décodage, pas un encodage : la passe
    // écrit dans le vide.
    assert.deepEqual(args.slice(-3), ['-f', 'null', '-'])
    assert.include(args, '-vn')
    assert.notInclude(args, '-c:a')
    assert.notInclude(args, '-b:a')
  })

  test('la passe de sortie force la fréquence, le débit et le conteneur', ({ assert }) => {
    const args = radioOutputArgs('abc-123', MEASURED)

    // ⚠️ **La panne évitée.** `loudnorm` sort en 192 kHz : sans `-ar`, l'encodeur
    // AAC reçoit du 192 kHz et écrit un fichier bien plus lourd que le débit
    // demandé, que certains lecteurs refusent — et le fichier joue quand même en
    // local, donc rien ne signale la panne.
    const at = args.indexOf('-ar')
    assert.isAbove(at, -1, '-ar absent : loudnorm sortirait en 192 kHz')
    assert.equal(args[at + 1], String(RADIO_FORMAT.sampleRate))

    assert.deepEqual(
      [args[args.indexOf('-b:a') + 1], args[args.indexOf('-f') + 1]],
      [RADIO_FORMAT.bitrate, RADIO_FORMAT.container]
    )
    // Un seul débit, une seule sortie : la dernière lexème est le seul fichier.
    assert.equal(args[args.length - 1], radioTrackPath('abc-123'))
    assert.lengthOf(
      args.filter((token) => token === '-map'),
      1
    )
  })

  test('un seul débit, et ce n’est pas le plancher de l’échelle HLS', ({ assert }) => {
    // Ce fichier n'est pas écouté : liquidsoap le ré-encode. Le calibrer sur le
    // débit de l'antenne ferait payer deux fois la perte lossy.
    assert.equal(RADIO_FORMAT.bitrate, '128k')
    assert.equal(RADIO_FORMAT.extension, 'm4a')
    assert.equal(RADIO_FORMAT.contentType, 'audio/mp4')
  })

  test('la cible de niveau est celle de la diffusion en ligne', ({ assert }) => {
    assert.equal(RADIO_LOUDNESS.targetI, -16)
    // Marge pour le ré-encodage lossy de liquidsoap : un pic à -0,1 dBTP
    // fabriquerait des pics inter-échantillons au-dessus de 0.
    assert.isBelow(RADIO_LOUDNESS.targetTp, -1)
  })
})

test.group('étiquettes de la source (issue #46)', () => {
  test('lit les clés sans se soucier de leur casse', ({ assert }) => {
    // ⚠️ **La panne évitée.** MP4 et ID3 rendent `title` ; un commentaire Vorbis
    // (FLAC, Ogg) est écrit `TITLE` et ressort tel quel. Une lecture directe
    // aurait marché sur un MP3 et rendu `null` sur un FLAC — un trou qui ne se
    // voit qu'avec le bon fichier.
    const tags = readTags({ TITLE: 'Jésus est vivant', ARTIST: 'Chorale', ALBUM: 'Louange' })
    assert.deepEqual(tags, {
      title: 'Jésus est vivant',
      artist: 'Chorale',
      album: 'Louange',
    })
  })

  test('retombe sur les étiquettes de la piste quand le conteneur est muet', ({ assert }) => {
    // Un Ogg range ses métadonnées sur le flux, pas sur le conteneur : ne lire
    // que `format_tags` les perdrait en silence.
    const tags = readTags(undefined, { title: 'Sur le flux' })
    assert.equal(tags.title, 'Sur le flux')
  })

  test('le conteneur a le dernier mot sur la piste', ({ assert }) => {
    const tags = readTags({ title: 'Conteneur' }, { title: 'Flux' })
    assert.equal(tags.title, 'Conteneur')
  })

  test('une étiquette vide est une étiquette absente', ({ assert }) => {
    // Le portail en fait une valeur par défaut au dépôt : proposer une chaîne
    // vide ferait remplir le champ de l'administrateur avec du vide.
    assert.deepEqual(readTags({ title: '   ', artist: '' }), {
      title: null,
      artist: null,
      album: null,
    })
  })

  test('aucune étiquette rend les trois champs nuls, jamais undefined', ({ assert }) => {
    assert.deepEqual(readTags(), { title: null, artist: null, album: null })
  })
})
