import { test } from '@japa/runner'
import { SourceStaging } from '#transcodes/services/source_staging'
import { stagedSourcePath } from '#transcodes/support/hls'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'

/**
 * **Le rapatriement de la source**, avant l'encodage.
 *
 * Il existe pour séparer deux durées que ffmpeg confondait : lire la source et
 * l'encoder. Mesuré en production, 5,7× le temps réel contre 55× depuis un
 * fichier local — et un dépôt peut peser 2 Go.
 *
 * Ce que ces tests surveillent n'est pas la vitesse, qui ne se teste pas ici.
 * C'est ce qui rendrait la mesure fausse ou le disque plein : un octet perdu en
 * chemin, une copie de travail abandonnée, un refus du serveur pris pour un
 * fichier vide.
 */
test.group('SourceStaging', (group) => {
  const id = `test-staging-${Date.now()}`
  /** Assez gros pour traverser plusieurs morceaux de flux. */
  const payload = Buffer.alloc(512_000, 7)

  let server: Server
  let origin: string

  group.setup(async () => {
    server = createServer((request, response) => {
      if (request.url === '/refuse') {
        response.writeHead(403)
        response.end('nope')
        return
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(payload)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    return async () => {
      await rm(stagedSourcePath(id), { force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('la source arrive entière, et sa taille est rendue', async ({ assert }) => {
    const staged = await new SourceStaging().fetch(`${origin}/sermon`, id)

    assert.equal(staged.path, stagedSourcePath(id))
    // **Octet pour octet.** Un transfert tronqué produirait un fichier que
    // ffmpeg encoderait quand même — en s'arrêtant au milieu du sermon, sans
    // que rien ne le signale.
    assert.equal(staged.bytes, payload.byteLength)
    assert.isTrue(Buffer.from(await readFile(staged.path)).equals(payload))
  })

  test('un refus du serveur lève, et ne laisse pas de fichier vide', async ({ assert }) => {
    await rm(stagedSourcePath(id), { force: true })

    await assert.rejects(() => new SourceStaging().fetch(`${origin}/refuse`, id))

    // Le piège serait un fichier de zéro octet : la reprise le trouverait,
    // l'encoderait, et produirait un transcodage vide plutôt qu'un échec.
    assert.isFalse(existsSync(stagedSourcePath(id)))
  })

  test('la copie de travail s’efface, et son effacement ne lève jamais', async ({ assert }) => {
    const staging = new SourceStaging()
    await staging.fetch(`${origin}/sermon`, id)
    assert.isTrue(existsSync(stagedSourcePath(id)))

    await staging.discard(id)
    assert.isFalse(existsSync(stagedSourcePath(id)))

    // Appelée dans un `finally`, elle doit rester muette sur un fichier déjà
    // parti : un nettoyage qui lève masquerait l'erreur qui l'a déclenché.
    await staging.discard(id)
  })
})
