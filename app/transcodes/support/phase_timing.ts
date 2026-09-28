import logger from '@adonisjs/core/services/logger'

/**
 * **Combien de temps a pris chaque étape d'un transcodage**, et rien d'autre.
 *
 * ## Pourquoi mesurer avant d'optimiser
 *
 * Un transcodage lent est un fait ; *où* il est lent est une hypothèse, et les
 * hypothèses sur ce sujet se ressemblent toutes — « c'est le CPU », « c'est le
 * disque », « c'est ffmpeg ». Ce chemin-ci enchaîne quatre étapes de natures très
 * différentes (une sonde, un encodage, et **deux envois réseau qui font un aller-retour
 * par fichier**), et rien dans le service ne disait laquelle durait. On optimisait
 * donc de mémoire.
 *
 * Une ligne par transcodage terminé suffit à trancher, et elle se lit dans les
 * journaux du conteneur sans rien installer.
 *
 * ## Ce que cette horloge n'est pas
 *
 * Ni une métrique, ni un histogramme, ni une trace : il n'y a pas de collecteur
 * sur ce VPS, et en poser un pour répondre à une question qu'une ligne de journal
 * règle serait construire l'échafaudage avant de savoir s'il y a un mur.
 *
 * Elle n'échoue jamais non plus : `performance.now()` ne lève pas, et une mesure
 * n'a **aucun** droit de faire échouer le travail qu'elle observe.
 */
export class PhaseTimings {
  readonly #started = performance.now()
  readonly #phases: { phase: string; ms: number; detail?: number }[] = []

  /**
   * Exécute [run] en retenant sa durée sous le nom [phase].
   *
   * L'erreur **remonte** telle quelle : une étape qui échoue n'est pas une étape
   * qu'on n'a pas mesurée, c'est un travail qui s'arrête — et le faire taire pour
   * garder la mesure inverserait l'ordre des priorités.
   */
  async time<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const at = performance.now()
    const result = await run()
    this.#phases.push({ phase, ms: Math.round(performance.now() - at) })
    return result
  }

  /**
   * Comme [time], en retenant en plus **combien d'unités** l'étape a traitées.
   *
   * C'est ce qui rend l'envoi HLS lisible : « 214 s » ne dit rien, « 3604 fichiers
   * en 214 s » dit que le coût est par fichier et non par octet, ce qui désigne le
   * remède (envoyer en parallèle) plutôt qu'un autre (compresser, changer de disque).
   */
  async count(phase: string, run: () => Promise<number>): Promise<number> {
    const at = performance.now()
    const detail = await run()
    this.#phases.push({ phase, ms: Math.round(performance.now() - at), detail })
    return detail
  }

  /**
   * Pose la ligne de journal, une fois, à la fin.
   *
   * En `info` : elle sort une fois par sermon déposé, soit quelques fois par
   * semaine. La passer en `debug` reviendrait à ne jamais la voir en production,
   * c'est-à-dire à n'avoir rien mesuré.
   */
  log(id: string): void {
    const total = Math.round(performance.now() - this.#started)
    logger.info(
      {
        transcode: id,
        totalMs: total,
        phases: Object.fromEntries(
          this.#phases.map(({ phase, ms, detail }) => [
            phase,
            detail === undefined ? ms : { ms, items: detail },
          ])
        ),
      },
      `transcode ${id} terminé en ${(total / 1000).toFixed(1)} s`
    )
  }
}
