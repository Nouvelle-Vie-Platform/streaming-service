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

  test('un job qui n’a rien mesuré ne rend aucun rapport', async ({ assert }) => {
    // Le cas qui a mordu, en production : le job d'archivage d'une ingestion par
    // URL n'a rien à archiver — l'original vit à son URL —, il se réduit au
    // nettoyage. La ligne annonçait pourtant « realtimeFactor: 26730 », soit
    // 5533 s d'audio divisées par 0,2 s de `rm`.
    //
    // Un nombre qui a l'air d'une mesure et n'en est pas est **pire que pas de
    // nombre** : il se recopie dans un rapport, et il se défend.
    const timings = new PhaseTimings()

    const payload = timings.payload('019f…', { audioSeconds: 5533, regime: 'archive' })

    assert.notProperty(payload, 'realtimeFactor')
    assert.notProperty(payload, 'encodeFactor')
    assert.notProperty(payload, 'audioSeconds')
    // Et on dit pourquoi : une ligne sans chiffres doit se distinguer d'une
    // ligne dont les chiffres se sont perdus.
    assert.equal(payload.note, 'rien à mesurer')
  })

  test('le rapport de l’encodage est celui de l’étape, pas du total', async ({ assert }) => {
    const timings = new PhaseTimings()

    // 1 s d'encodage, puis une étape qui ne l'est pas : `encodeFactor` ne doit
    // regarder que la première. Sur le sermon mesuré, `totalMs` mêlait l'envoi,
    // qui ne pèse que 5 % — assez pour faire lire ×5,4 au lieu de ×5,7, donc
    // pour brouiller le seul chiffre qui accuse la sérialisation.
    await timings.time('encode', () => new Promise((resolve) => setTimeout(resolve, 60)))
    await timings.time('uploadHls', () => new Promise((resolve) => setTimeout(resolve, 60)))

    const payload = timings.payload('019f…', { audioSeconds: 600 })

    // 600 s d'audio pour ~60 ms d'encodage : l'ordre de grandeur suffit, et il
    // doit être **deux fois** celui calculé sur le total.
    const encode = payload.encodeFactor as number
    const overall = payload.realtimeFactor as number
    assert.isAbove(encode, overall * 1.5)
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
