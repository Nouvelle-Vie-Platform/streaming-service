import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { TokenVerifier } from '#common/services/token_verifier'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { TranscodeQueue } from '#transcodes/queues/transcode_queue'
import { ArchiveQueue } from '#transcodes/queues/archive_queue'
import Transcode from '#transcodes/models/transcode'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'

const UNKNOWN_ID = '0191ffff-0000-7000-8000-0000000000ff'

/** A valid token, so requests get past auth and reach the route. */
function authed() {
  app.container.swap(TokenVerifier, () => {
    return { verify: async () => true } as unknown as TokenVerifier
  })
}

/** Records what the route asks RustFS to destroy, without touching a bucket. */
function rustfsSpy() {
  const calls = { prefixes: [] as string[], objects: [] as string[] }
  app.container.swap(RustfsStorage, () => {
    return {
      deletePrefix: async (prefix: string) => {
        calls.prefixes.push(prefix)
        return 0
      },
      deleteObject: async (key: string) => {
        calls.objects.push(key)
      },
    } as unknown as RustfsStorage
  })
  return calls
}

/**
 * Stands in for the two queues. `owned` = a worker holds that job, i.e. the
 * withdrawal fails — the only reason a deletion is refused (ADR-0008).
 */
function queues(owned: { transcode?: boolean; archive?: boolean } = {}) {
  const withdrawn: string[] = []
  app.container.swap(TranscodeQueue, () => {
    return {
      withdraw: async (id: string) => {
        withdrawn.push(`transcode:${id}`)
        return !owned.transcode
      },
    } as unknown as TranscodeQueue
  })
  app.container.swap(ArchiveQueue, () => {
    return {
      withdraw: async (id: string) => {
        withdrawn.push(`archive:${id}`)
        return !owned.archive
      },
    } as unknown as ArchiveQueue
  })
  return withdrawn
}

/** An existing Transcode row; the id is unique per test to avoid collisions. */
async function seed(id: string, fields: Partial<Transcode> = {}) {
  return Transcode.create({
    id,
    status: 'COMPLETED',
    originalFilename: 'sermon.mp3',
    sourceKind: 'audio',
    ...fields,
  })
}

test.group('DELETE /transcodes/:id', (group) => {
  group.each.setup(() => authed())
  group.each.teardown(async () => {
    app.container.restore(TokenVerifier)
    app.container.restore(RustfsStorage)
    app.container.restore(TranscodeQueue)
    app.container.restore(ArchiveQueue)
    await Transcode.query().delete()
  })

  test('takes back the HLS prefix, the archive and the row', async ({ client, assert }) => {
    const id = '0191ffff-0000-7000-8000-000000000101'
    const rustfs = rustfsSpy()
    queues()
    await seed(id, { archiveKey: `archives/${id}.flac` })

    const response = await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')

    response.assertStatus(204)
    // Les trois préfixes de diffusion sont repris : le HLS, les `.aac` (ADR-0009)
    // et la piste radio (issue #46). **Sans regarder le profil** : un préfixe
    // vide n'efface rien, alors qu'une reprise qui se fie à la colonne laisserait
    // des octets servables le jour où la colonne et les octets ne s'accordent pas.
    assert.deepEqual(rustfs.prefixes, [`hls/${id}`, `dl/${id}`, `radio/${id}`])
    assert.deepEqual(rustfs.objects, [`archives/${id}.flac`])
    assert.isNull(await Transcode.find(id))
  })

  test('a URL ingestion has no archive, and that is not an error', async ({ client, assert }) => {
    // ADR-0007: the master is the caller's object. Nothing but the HLS is ours
    // to destroy — and the source URL is never dereferenced, let alone deleted.
    const id = '0191ffff-0000-7000-8000-000000000102'
    const rustfs = rustfsSpy()
    queues()
    await seed(id, { sourceUrl: 'https://caller.example.com/master.wav', archiveKey: null })

    const response = await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')

    response.assertStatus(204)
    // The `.aac` downloads are produced on the URL path too, so every serving
    // prefix goes (ADR-0009, issue #46) — and a radio ingestion is *always* a URL
    // ingestion, so this is the shape that matters in production.
    assert.deepEqual(rustfs.prefixes, [`hls/${id}`, `dl/${id}`, `radio/${id}`])
    assert.isEmpty(rustfs.objects)
  })

  test('an archive the job never recorded is still reclaimed', async ({ client, assert }) => {
    // COMPLETED but the archive job has not written `archive_key` back yet: the
    // FLAC may already be in the bucket, so aim at the deterministic key.
    const id = '0191ffff-0000-7000-8000-000000000103'
    const rustfs = rustfsSpy()
    queues()
    await seed(id, { archiveKey: null })

    await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')

    assert.deepEqual(rustfs.objects, [`archives/${id}.flac`])
  })

  test('a queued PENDING transcode is withdrawn and its source reclaimed', async ({
    client,
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-000000000104'
    rustfsSpy()
    const withdrawn = queues()
    await seed(id, { status: 'PENDING' })

    const sourcesRoot = app.makePath('storage/sources')
    await mkdir(sourcesRoot, { recursive: true })
    const source = app.makePath('storage/sources', `${id}.mp3`)
    await writeFile(source, 'not really audio')

    const response = await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')

    response.assertStatus(204)
    assert.deepEqual(withdrawn, [`transcode:${id}`, `archive:${id}`])
    assert.isFalse(existsSync(source), 'the staged Source must not survive its Transcode')
    assert.isNull(await Transcode.find(id))
  })

  test('a Transcode a worker holds is refused, and survives intact', async ({ client, assert }) => {
    const id = '0191ffff-0000-7000-8000-000000000105'
    const rustfs = rustfsSpy()
    queues({ transcode: true })
    await seed(id, { status: 'PROCESSING' })

    const response = await client
      .delete(`/transcodes/${id}`)
      .accept('json')
      .header('Authorization', 'Bearer ok')

    response.assertStatus(409)
    response.assertBodyContains({ code: 'E_TRANSCODE_IN_PROGRESS' })
    assert.isEmpty(rustfs.prefixes, 'nothing may be destroyed when the deletion is refused')
    assert.isNotNull(await Transcode.find(id))
  })

  test('an archive job in flight refuses too', async ({ client, assert }) => {
    // The transcode job is done, but the FLAC upload is running: deleting now
    // would let it re-create an archive nothing points to.
    const id = '0191ffff-0000-7000-8000-000000000106'
    const rustfs = rustfsSpy()
    queues({ archive: true })
    await seed(id)

    const response = await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')

    response.assertStatus(409)
    assert.isEmpty(rustfs.prefixes)
    assert.isNotNull(await Transcode.find(id))
  })

  test('deleting twice leaves the same state; the second call is a 404', async ({
    client,
    assert,
  }) => {
    const id = '0191ffff-0000-7000-8000-000000000107'
    rustfsSpy()
    queues()
    await seed(id)

    const first = await client.delete(`/transcodes/${id}`).header('Authorization', 'Bearer ok')
    const second = await client
      .delete(`/transcodes/${id}`)
      .accept('json')
      .header('Authorization', 'Bearer ok')

    first.assertStatus(204)
    second.assertStatus(404)
    second.assertBodyContains({ code: 'E_TRANSCODE_NOT_EXISTS' })
    assert.isNull(await Transcode.find(id))
  })

  test('an unknown id is 404, like the status route', async ({ client }) => {
    rustfsSpy()
    queues()

    const response = await client
      .delete(`/transcodes/${UNKNOWN_ID}`)
      .accept('json')
      .header('Authorization', 'Bearer ok')

    response.assertStatus(404)
    response.assertBodyContains({ code: 'E_TRANSCODE_NOT_EXISTS' })
  })
})
