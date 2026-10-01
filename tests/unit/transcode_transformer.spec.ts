import { test } from '@japa/runner'
import TranscodeTransformer from '#transcodes/transformers/transcode_transformer'
import type Transcode from '#transcodes/models/transcode'
import type { RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'

/** A Transcode-shaped stub — the transformer only reads plain columns. */
function transcode(fields: Record<string, unknown>): Transcode {
  return fields as unknown as Transcode
}

/** Une piste radio telle que `ProcessTranscode` la pose sur la ligne. */
const RADIO_TRACK: RadioTrackInfo = {
  url: 'https://media.example.com/radio/01a1/track.m4a',
  bytes: 2_996_000,
  durationSeconds: 187,
  loudness: {
    targetI: -16,
    inputI: -27.5,
    inputTp: -3.25,
    inputLra: 4.75,
    outputI: -16.02,
    outputTp: -4.1,
    outputLra: 4.7,
    normalization: 'linear',
  },
  tags: { title: 'Jésus est vivant', artist: 'Chorale', album: 'Louange 2026' },
}

/** Ce qu'un Spark publie, tel que `ProcessTranscode` le pose sur la ligne. */
const SPARK_MEDIA: SparkMedia = {
  playlist: 'https://media.example.com/hls/01b2/master.m3u8',
  poster: 'https://media.example.com/hls/01b2/poster.jpg',
  hasVideo: true,
  durationSeconds: 28.4,
  waveform: [
    0, 0, 3, 41, 78, 92, 100, 87, 64, 51, 44, 39, 35, 30, 28, 25, 22, 20, 18, 17, 15, 14, 12, 11,
    10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0,
  ],
  loudness: {
    targetI: -16,
    inputI: -23.01,
    inputTp: -10.78,
    inputLra: 8,
    outputI: -15.71,
    outputTp: -5.03,
    outputLra: 8,
    normalization: 'linear',
  },
  tags: { title: 'Rassemblement de jeunesse', artist: null, album: null },
}

test.group('TranscodeTransformer', () => {
  test('serves exactly the unified 5-field shape', ({ assert }) => {
    const out = new TranscodeTransformer(
      transcode({ id: 'id-1', status: 'PENDING', outputPlaylist: null, error: null })
    ).toObject()
    assert.deepEqual(Object.keys(out).sort(), [
      'error',
      'id',
      'outputPlaylist',
      'progress',
      'status',
    ])
  })

  test('derives progress from status when no live value is passed', ({ assert }) => {
    assert.equal(new TranscodeTransformer(transcode({ status: 'PENDING' })).toObject().progress, 0)
    assert.equal(
      new TranscodeTransformer(transcode({ status: 'COMPLETED' })).toObject().progress,
      100
    )
  })

  test('a live progress value overrides — including 0', ({ assert }) => {
    assert.equal(
      new TranscodeTransformer(transcode({ status: 'PROCESSING' }), 42).toObject().progress,
      42
    )
    assert.equal(
      new TranscodeTransformer(transcode({ status: 'PROCESSING' }), 0).toObject().progress,
      0
    )
  })

  test('coerces unset nullable columns to null (never undefined)', ({ assert }) => {
    const out = new TranscodeTransformer(transcode({ id: 'x', status: 'PENDING' })).toObject()
    assert.isNull(out.outputPlaylist)
    assert.isNull(out.error)
  })

  test('un enseignement terminé ne gagne aucun champ (ADR-0010)', ({ assert }) => {
    // La garde de non-régression du contrat : la forme à cinq champs est celle
    // que le portail consomme depuis le premier jalon.
    const out = new TranscodeTransformer(
      transcode({
        id: 'id-2',
        status: 'COMPLETED',
        outputPlaylist: 'https://m/hls/id-2/master.m3u8',
        error: null,
        radioTrack: null,
      })
    ).toObject()
    assert.notProperty(out, 'radioTrack')
    assert.notProperty(out, 'sparkMedia')
    assert.lengthOf(Object.keys(out), 5)
  })

  test('une radio terminée publie sa sortie, et garde outputPlaylist à null', ({ assert }) => {
    // ⚠️ **Le chemin de rattrapage.** Le portail règle un dépôt depuis ce
    // snapshot quand un webhook s'est perdu. Sans la sortie ici, un dépôt radio
    // dont le webhook est perdu serait définitivement irrécupérable.
    const out = new TranscodeTransformer(
      transcode({
        id: 'id-3',
        status: 'COMPLETED',
        outputPlaylist: null,
        error: null,
        radioTrack: RADIO_TRACK,
      })
    ).toObject()

    assert.deepEqual(out.radioTrack, RADIO_TRACK)
    // `null` n'est pas une anomalie sur ce profil : il n'y a pas de playlist, et
    // la sortie se lit sous son propre nom.
    assert.isNull(out.outputPlaylist)
    assert.equal(out.progress, 100)
  })

  test('un Spark terminé publie sa sortie ET garde sa playlist (ADR-0011)', ({ assert }) => {
    // La différence avec la radio : un Spark produit un vrai jeu HLS, donc
    // `outputPlaylist` est rempli et porte ce que son nom dit. La garde « terminé
    // sans média » de l'appelant n'a rien à apprendre sur ce profil.
    const out = new TranscodeTransformer(
      transcode({
        id: 'id-5',
        status: 'COMPLETED',
        outputPlaylist: 'https://m/hls/id-5/master.m3u8',
        error: null,
        sparkMedia: SPARK_MEDIA,
      })
    ).toObject()

    assert.deepEqual(out.sparkMedia, SPARK_MEDIA)
    assert.equal(out.outputPlaylist, 'https://m/hls/id-5/master.m3u8')
    // `playlist` redit `outputPlaylist` exprès : un lecteur de `sparkMedia` n'a
    // pas à savoir qu'une moitié de sa réponse est ailleurs.
    assert.equal(out.sparkMedia!.playlist, SPARK_MEDIA.playlist)
    assert.notProperty(out, 'radioTrack')
  })

  test('un Spark encore en cours ne publie rien de sa sortie', ({ assert }) => {
    // Même garde que la radio, même raison : la colonne existe dès la fin de
    // l'encodage, les octets ne sont servables qu'à `COMPLETED`.
    const out = new TranscodeTransformer(
      transcode({ id: 'id-6', status: 'PROCESSING', sparkMedia: SPARK_MEDIA }),
      71
    ).toObject()

    assert.notProperty(out, 'sparkMedia')
    assert.equal(out.progress, 71)
  })

  test('une radio encore en cours ne publie pas son URL', ({ assert }) => {
    // La colonne existe dès la fin de l'encodage, **avant** l'envoi vers RustFS.
    // Publier l'URL à PROCESSING annoncerait des octets qui ne sont pas encore
    // servables — ce que `COMPLETED` promet et que ce profil ne doit pas trahir.
    const out = new TranscodeTransformer(
      transcode({ id: 'id-4', status: 'PROCESSING', radioTrack: RADIO_TRACK }),
      63
    ).toObject()

    assert.notProperty(out, 'radioTrack')
    assert.equal(out.progress, 63)
  })
})
