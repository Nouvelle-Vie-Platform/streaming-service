import { test } from '@japa/runner'
import type Transcode from '#transcodes/models/transcode'
import { PipelineFirehose } from '#transcodes/services/pipeline_firehose'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import type { RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'

const ID = '0191ffff-0000-7000-8000-000000000200'

/** Une piste radio telle que `ProcessTranscode` la pose sur la ligne. */
const RADIO_TRACK: RadioTrackInfo = {
  url: `https://media.example.com/radio/${ID}/track.m4a`,
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
  playlist: `https://media.example.com/hls/${ID}/master.m3u8`,
  poster: `https://media.example.com/hls/${ID}/poster.jpg`,
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

/** A firehose that records what the publisher fans out, without a real Redis. */
class FirehoseSpy extends PipelineFirehose {
  events: unknown[] = []
  async publish(event: unknown): Promise<void> {
    this.events.push(event)
  }
}

/** A minimal Transcode-shaped stand-in — the transformer reads only these fields. */
function fakeTranscode(fields: Partial<Transcode> = {}): Transcode {
  return {
    id: ID,
    status: 'PROCESSING',
    outputPlaylist: null,
    error: null,
    ...fields,
  } as unknown as Transcode
}

test.group('TranscodePublisher raw firehose', () => {
  test('publishes the lifecycle event on the pipeline firehose', async ({ assert }) => {
    const firehose = new FirehoseSpy()
    const publisher = new TranscodePublisher(firehose)

    publisher.broadcast(fakeTranscode(), 42)

    assert.deepEqual(firehose.events, [
      {
        transcodeId: ID,
        status: 'PROCESSING',
        progress: 42,
        error: null,
        outputPlaylist: null,
      },
    ])
  })

  test('carries the terminal outcome (playlist / error) on the firehose', async ({ assert }) => {
    const firehose = new FirehoseSpy()
    const publisher = new TranscodePublisher(firehose)

    publisher.broadcast(
      fakeTranscode({ status: 'COMPLETED', outputPlaylist: 'https://m/hls/x/master.m3u8' }),
      100
    )

    assert.deepEqual(firehose.events, [
      {
        transcodeId: ID,
        status: 'COMPLETED',
        progress: 100,
        error: null,
        outputPlaylist: 'https://m/hls/x/master.m3u8',
      },
    ])
  })

  test('une radio terminée porte sa sortie sur le firehose (ADR-0010)', async ({ assert }) => {
    /*
     * ⚠️ **Une surface d'observabilité n'a pas le droit de mentir, même sans
     * perdre de donnée.**
     *
     * Sur ce profil `outputPlaylist` vaut `null` par construction : sans ce champ,
     * la page d'ops présenterait **chaque** radio réussie comme « terminée sans
     * média », c'est-à-dire en panne. La doctrine de la plateforme est explicite —
     * un indicateur qui montre zéro apprend à être ignoré — et une fausse alerte
     * récurrente est pire qu'un silence : elle finit par faire ignorer les vraies.
     */
    const firehose = new FirehoseSpy()
    const publisher = new TranscodePublisher(firehose)

    publisher.broadcast(
      fakeTranscode({ status: 'COMPLETED', outputPlaylist: null, radioTrack: RADIO_TRACK }),
      100
    )

    assert.deepEqual(firehose.events, [
      {
        transcodeId: ID,
        status: 'COMPLETED',
        progress: 100,
        error: null,
        outputPlaylist: null,
        radioTrack: RADIO_TRACK,
      },
    ])
  })

  test('un Spark terminé porte sa sortie sur le firehose (ADR-0011)', async ({ assert }) => {
    // Ici la raison n'est pas qu'une page d'ops mentirait — `outputPlaylist` est
    // rempli sur ce profil. C'est que **la proportion de `normalization: dynamic`**
    // est le chiffre à surveiller en production, et que ce canal est le seul qui
    // le donne sans requête.
    const firehose = new FirehoseSpy()
    const publisher = new TranscodePublisher(firehose)

    publisher.broadcast(
      fakeTranscode({
        status: 'COMPLETED',
        outputPlaylist: SPARK_MEDIA.playlist,
        sparkMedia: SPARK_MEDIA,
      }),
      100
    )

    assert.deepEqual(firehose.events, [
      {
        transcodeId: ID,
        status: 'COMPLETED',
        progress: 100,
        error: null,
        outputPlaylist: SPARK_MEDIA.playlist,
        sparkMedia: SPARK_MEDIA,
      },
    ])
  })

  test('les deux gardes sont héritées, pas recopiées', async ({ assert }) => {
    // Le firehose ne rejuge rien : il relaie ce que `TranscodeTransformer` a
    // laissé passer. Une radio encore en cours porte déjà `radio_track` en base
    // (écrit avant l'envoi vers RustFS), et l'événement n'en dit pourtant rien —
    // la preuve que la règle vit à un seul endroit.
    const firehose = new FirehoseSpy()
    const publisher = new TranscodePublisher(firehose)

    publisher.broadcast(fakeTranscode({ status: 'PROCESSING', radioTrack: RADIO_TRACK }), 63)

    assert.deepEqual(firehose.events, [
      {
        transcodeId: ID,
        status: 'PROCESSING',
        progress: 63,
        error: null,
        outputPlaylist: null,
      },
    ])
  })

  /*
   * Les deux premiers cas de ce fichier n'ont **pas** eu à changer quand la sortie
   * radio est arrivée sur le firehose : le champ est conditionnel, et un
   * enseignement n'en porte pas. C'est le même invariant que garde le contrat
   * unifié — un régime existant ne gagne pas un champ parce qu'un autre profil est
   * né.
   */
})
