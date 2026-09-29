import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { TokenVerifier } from '#common/services/token_verifier'

/** A valid token, so requests get past auth and reach validation. */
function authed() {
  app.container.swap(TokenVerifier, () => {
    return { verify: async () => true } as unknown as TokenVerifier
  })
}

test.group('Validation', (group) => {
  group.each.setup(() => authed())
  group.each.teardown(() => app.container.restore(TokenVerifier))

  test('a malformed transcode id is 422', async ({ client }) => {
    const response = await client
      .get('/transcodes/not-a-uuid/status')
      .header('Authorization', 'Bearer ok')
    response.assertStatus(422)
  })

  test('a malformed transcode id is 422 on delete too', async ({ client }) => {
    const response = await client
      .delete('/transcodes/not-a-uuid')
      .header('Authorization', 'Bearer ok')
    response.assertStatus(422)
  })

  test('URL ingestion without a sourceUrl is 422', async ({ client }) => {
    const response = await client.post('/transcodes').header('Authorization', 'Bearer ok').json({})
    response.assertStatus(422)
  })

  test('URL ingestion with a non-URL sourceUrl is 422', async ({ client }) => {
    const response = await client
      .post('/transcodes')
      .header('Authorization', 'Bearer ok')
      .json({ sourceUrl: 'not-a-url' })
    response.assertStatus(422)
  })

  test('URL ingestion with an unknown profile is 422', async ({ client }) => {
    // Un profil inventé est refusé au bord (issue #46). Accepté, il atterrirait
    // en base et ferait échouer un worker une heure plus tard, loin de l'appel
    // qui s'est trompé.
    const response = await client
      .post('/transcodes')
      .header('Authorization', 'Bearer ok')
      .json({ sourceUrl: 'https://bucket.example.com/titre.mp3', profile: 'gospel' })
    response.assertStatus(422)
  })
})
