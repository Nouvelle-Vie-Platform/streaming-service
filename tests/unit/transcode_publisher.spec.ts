import { test } from '@japa/runner'
import type Transcode from '#transcodes/models/transcode'
import { PipelineFirehose } from '#transcodes/services/pipeline_firehose'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import type { RadioTrackInfo } from '#transcodes/support/hls'

const ID = '0191ffff-0000-7000-8000-000000000200'

/** Une piste radio telle que `ProcessTranscode` la pose sur la ligne. */
const RADIO_TRACK: RadioTrackInfo = {
  url: `https://media.example.com/radio/${ID}/track.m4a`,
  bytes: 2_996_000,
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
