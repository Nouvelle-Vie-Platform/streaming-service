import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Transcode from '#transcodes/models/transcode'
import { TokenVerifier } from '#common/services/token_verifier'
import { ProgressStore } from '#transcodes/services/progress_store'
import { outputPlaylistUrl, sparksPosterUrl } from '#transcodes/support/hls'
import type { SparkMedia } from '#transcodes/support/hls'
import { WAVEFORM_BARS } from '#transcodes/support/waveform'

/** Un jeton valide, pour que la requête franchisse l'auth et atteigne la route. */
function authed() {
  app.container.swap(TokenVerifier, () => {
    return { verify: async () => true } as unknown as TokenVerifier
  })
}

/** Redis muet : la progression retombe sur celle que déduit le statut. */
function silentProgress() {
  app.container.swap(ProgressStore, () => {
    return { get: async () => null } as unknown as ProgressStore
  })
}

function sparkMedia(id: string): SparkMedia {
  return {
    playlist: outputPlaylistUrl(id),
    poster: sparksPosterUrl(id),
    hasVideo: true,
    durationSeconds: 28.4,
    waveform: Array.from({ length: WAVEFORM_BARS }, (_, bar) => (bar < 3 ? 0 : 40 + bar)),
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
}

test.group('GET /transcodes/:id/status — profil sparks (ADR-0011)', (group) => {
  group.each.setup(() => {
    authed()
    silentProgress()
  })
  group.each.teardown(async () => {
    app.container.restore(TokenVerifier)
    app.container.restore(ProgressStore)
    await Transcode.query().delete()
  })

  test('un Spark terminé expose sa sortie entière, imbrication comprise', async ({
    client,
    assert,
  }) => {
    /*
     * ⚠️ **Le chemin de rattrapage, et la couche de sérialisation.**
     *
     * Le portail règle un dépôt depuis ce snapshot quand un webhook s'est perdu :
     * sans ce champ ici, un Spark dont le webhook est perdu serait définitivement
     * irrécupérable — la forme d'onde, le niveau et la vignette ne se relisent
     * nulle part ailleurs, le webhook ne repart pas, et la passe ne sera pas
     * rejouée.
     *
     * Et ce test passe par `serialize()`, donc il vérifie en plus que l'objet
     * imbriqué et son **tableau de trente-six entiers** traversent la couche de
     * transformation sans être rabotés. Un test d'unité sur le transformateur ne
     * l'aurait pas dit.
     */
    const id = '0191ffff-0000-7000-8000-0000000004a1'
    const media = sparkMedia(id)
    await Transcode.create({
      id,
      status: 'COMPLETED',
      originalFilename: 'annonce.mp4',
      sourceKind: 'video',
      outputPlaylist: outputPlaylistUrl(id),
      sparkMedia: media,
    })

    const response = await client.get(`/transcodes/${id}/status`).bearerToken('jeton')
    response.assertStatus(200)

    // ⚠️ La charge est enveloppée sous `data` par le sérialiseur maison.
    const body = response.body().data
    assert.deepEqual(body.sparkMedia, media)
    assert.lengthOf(body.sparkMedia.waveform, WAVEFORM_BARS)
    // La playlist se lit où elle s'est toujours lue : c'est la différence avec le
    // profil radio, et elle dispense l'appelant d'une garde de plus.
    assert.equal(body.outputPlaylist, outputPlaylistUrl(id))
    assert.equal(body.progress, 100)
  })

  test('un Spark encore en cours ne publie rien de sa sortie', async ({ client, assert }) => {
    // La colonne existe dès la fin de l'encodage, **avant** l'envoi vers RustFS.
    // Publier les URL à `PROCESSING` annoncerait des octets qui ne sont pas encore
    // servables, ce que `COMPLETED` promet (ADR-0004).
    const id = '0191ffff-0000-7000-8000-0000000004a2'
    await Transcode.create({
      id,
      status: 'PROCESSING',
      originalFilename: 'annonce.mp4',
      sourceKind: 'video',
      sparkMedia: sparkMedia(id),
    })

    const response = await client.get(`/transcodes/${id}/status`).bearerToken('jeton')
    response.assertStatus(200)
    assert.notProperty(response.body().data, 'sparkMedia')
  })

  test('un enseignement terminé ne gagne aucun champ', async ({ client, assert }) => {
    // La garde de non-régression : la forme à cinq champs est celle que le portail
    // consomme depuis le premier jalon.
    const id = '0191ffff-0000-7000-8000-0000000004a3'
    await Transcode.create({
      id,
      status: 'COMPLETED',
      originalFilename: 'sermon.mp3',
      sourceKind: 'audio',
      outputPlaylist: outputPlaylistUrl(id),
    })

    const response = await client.get(`/transcodes/${id}/status`).bearerToken('jeton')
    response.assertStatus(200)
    assert.notProperty(response.body().data, 'sparkMedia')
    assert.notProperty(response.body().data, 'radioTrack')
  })
})
