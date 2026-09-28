import { test } from '@japa/runner'
import { PhaseTimings } from '#transcodes/support/phase_timing'

/**
 * **L'horloge des étapes du transcodage.**
 *
 * Elle existe pour répondre à une question de production — *où* passent les
 * minutes d'un sermon de deux heures —, et ce qu'on lui demande d'abord est de
 * ne pas nuire : une mesure n'a aucun droit d'avaler une erreur, d'en inventer
 * une, ni de faire croire qu'un travail s'est terminé alors qu'il a échoué.
 */
test.group('PhaseTimings', () => {
  test('rend ce que l’étape rend', async ({ assert }) => {
    const timings = new PhaseTimings()

    const value = await timings.time('probe', async () => ({ hasAudio: true }))

    // Elle s'intercale sans rien transformer : c'est ce qui permet de l'ajouter
    // sur un chemin existant sans relire tout ce qui en dépend.
    assert.deepEqual(value, { hasAudio: true })
  })

  test('une étape qui échoue relève son erreur, telle quelle', async ({ assert }) => {
    const timings = new PhaseTimings()
    const boom = new Error('ffmpeg exited with code 1')

    // La faire taire pour « garder la mesure » inverserait l'ordre des
    // priorités : le travail compte, la mesure l'observe.
    await assert.rejects(
      () => timings.time('encode', () => Promise.reject(boom)),
      'ffmpeg exited with code 1'
    )
  })

  test('le compteur rend le nombre d’unités traitées', async ({ assert }) => {
    const timings = new PhaseTimings()

    const sent = await timings.count('uploadHls', async () => 3604)

    // C'est ce nombre qui dit si le coût est **par fichier** ou **par octet**,
    // donc quel remède vise juste.
    assert.equal(sent, 3604)
  })

  test('le journal ne sort pas tout seul, il se demande', async ({ assert }) => {
    // Rien ne s'écrit tant que `log()` n'est pas appelé : c'est ce qui permet de
    // ne poser la ligne qu'après le succès, et donc de ne jamais journaliser
    // « terminé » sur un transcodage qui a échoué.
    const timings = new PhaseTimings()
    await timings.time('probe', async () => null)

    assert.doesNotThrow(() => timings.log('019f7000-0000-7000-8000-000000000001'))
  })
})
