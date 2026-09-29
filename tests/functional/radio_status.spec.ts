import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Transcode from '#transcodes/models/transcode'
import { TokenVerifier } from '#common/services/token_verifier'
import { ProgressStore } from '#transcodes/services/progress_store'
import { radioTrackUrl } from '#transcodes/support/hls'
import type { RadioTrackInfo } from '#transcodes/support/hls'

/** Un jeton valide, pour que la requête franchisse l'auth et atteigne la route. */
function authed() {
  app.container.swap(TokenVerifier, () => {
    return { verify: async () => true } as unknown as TokenVerifier
  })
}

/**
 * Redis muet : la progression retombe alors sur celle que déduit le statut. Le
 * sujet du test est la **sortie** publiée, pas le pourcentage, et un Redis
 * résiduel d'un autre test rendrait l'assertion instable.
 */
function silentProgress() {
  app.container.swap(ProgressStore, () => {
    return { get: async () => null } as unknown as ProgressStore
  })
}

function radioTrack(id: string): RadioTrackInfo {
  return {
    url: radioTrackUrl(id),
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
}

test.group('GET /transcodes/:id/status — profil radio (ADR-0010)', (group) => {
  group.each.setup(() => {
    authed()
    silentProgress()
  })
  group.each.teardown(async () => {
    app.container.restore(TokenVerifier)
    app.container.restore(ProgressStore)
    await Transcode.query().delete()
  })

  test('une radio terminée expose sa sortie, et garde outputPlaylist à null', async ({
    client,
    assert,
  }) => {
    /*
     * ⚠️ **C'est un chemin de rattrapage, pas un confort.**
     *
     * Le portail règle un dépôt depuis **ce snapshot** quand le webhook de
     * complétion a été perdu (son réconciliateur périodique). Sans la sortie ici,
     * un dépôt radio dont le webhook s'est perdu serait **définitivement
     * irrécupérable** : ni l'URL, ni le niveau, ni les étiquettes ne se relisent
     * ailleurs — le webhook ne repart pas, et la passe ne sera pas rejouée.
     */
    const id = '0191ffff-0000-7000-8000-0000000003a1'
    const track = radioTrack(id)
    await Transcode.create({
      id,
      status: 'COMPLETED',
      originalFilename: 'titre.mp3',
      sourceKind: 'audio',
      radioTrack: track,
    })

    const response = await client
      .get(`/transcodes/${id}/status`)
      .header('Authorization', 'Bearer ok')

    response.assertStatus(200)
    response.assertBodyContains({
      data: {
        id,
        status: 'COMPLETED',
        progress: 100,
        // `null` **n'est pas une anomalie** sur ce profil : il n'y a pas de
        // playlist. C'est le profil qui dit où regarder.
        outputPlaylist: null,
        error: null,
        radioTrack: track,
      },
    })

    // Non signée : une URL qui expire en pleine diffusion ferait taire l'antenne.
    assert.notInclude(response.body().data.radioTrack.url, '?')

    /*
     * **La durée est là, et c'est le point de ce test.** Le sondage de statut est
     * le chemin de rattrapage d'un webhook perdu : une durée qui n'existerait
     * qu'au premier niveau du webhook serait définitivement perdue si celui-ci
     * n'arrive pas, puisque la réécriture idempotente du portail ne la republie
     * pas — et l'antenne ne programme pas un morceau dont elle ignore la durée.
     * C'est la même raison qui fait voyager celle d'un enseignement dans
     * `download.duration`.
     */
    assert.equal(response.body().data.radioTrack.durationSeconds, 187)
  })

  test('un enseignement terminé sert la même forme qu’avant, sans champ de plus', async ({
    client,
    assert,
  }) => {
    // La garde de non-régression : le contrat unifié à cinq champs est celui que
    // le portail consomme depuis le premier jalon.
    const id = '0191ffff-0000-7000-8000-0000000003a2'
    await Transcode.create({
      id,
      status: 'COMPLETED',
      originalFilename: 'sermon.mp3',
      sourceKind: 'audio',
      outputPlaylist: `https://media.example.com/hls/${id}/master.m3u8`,
    })

    const response = await client
      .get(`/transcodes/${id}/status`)
      .header('Authorization', 'Bearer ok')

    response.assertStatus(200)
    assert.deepEqual(Object.keys(response.body().data).sort(), [
      'error',
      'id',
      'outputPlaylist',
      'progress',
      'status',
    ])
  })

  test('une radio encore en cours n’annonce pas une URL qui n’est pas servable', async ({
    client,
    assert,
  }) => {
    // La colonne `radio_track` est écrite dès la fin de l'encodage, **avant**
    // l'envoi vers RustFS : c'est le prix payé pour ne pas perdre le niveau et
    // les étiquettes sur une reprise. Le snapshot, lui, ne doit rien promettre
    // avant `COMPLETED` — c'est la définition même de cet état (ADR-0004).
    const id = '0191ffff-0000-7000-8000-0000000003a3'
    await Transcode.create({
      id,
      status: 'PROCESSING',
      originalFilename: 'titre.mp3',
      sourceKind: 'audio',
      radioTrack: radioTrack(id),
    })

    const response = await client
      .get(`/transcodes/${id}/status`)
      .header('Authorization', 'Bearer ok')

    response.assertStatus(200)
    assert.notProperty(response.body().data, 'radioTrack')
  })
})
