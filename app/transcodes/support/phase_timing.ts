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
/** Ce que la ligne porte **en plus** des durées, et qui ne se mesure pas. */
export interface LogContext {
  /** La durée de l'audio traité, en secondes — le dénominateur du ×temps-réel. */
  audioSeconds?: number | null
  /**
   * **Par où ffmpeg a lu la source** — et non pas comment l'enseignement a été
   * déposé. Les deux se confondent facilement, et la confusion coûte cher.
   *
   * ⚠️ **Un administrateur qui téléverse un fichier produit `url`.** Le portail
   * envoie le média vers RustFS, puis remet au service une **URL présignée**
   * (`StartMediaTranscode.presignRead`) : la seule route d'ingestion qu'il
   * appelle est `POST /transcodes`. `fichier` désigne `POST /upload`, que ce
   * service expose et que **cette plateforme n'utilise jamais**.
   *
   * La distinction reste journalisée parce qu'elle décide du reste : sur le
   * chemin `url`, ffmpeg lit la source **pendant** l'encodage (ici depuis le
   * RustFS de la même machine), et aucune archive FLAC n'est produite — le
   * master téléversé *est* l'archive, et la médiathèque ne le purge jamais
   * (ADR-0033 côté portail).
   *
   * `archive` est la seconde passe, celle du FLAC : elle porte le même
   * identifiant de transcodage et sortirait sinon comme un doublon inexplicable.
   */
  regime?: 'fichier' | 'url' | 'archive'
}

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
  log(id: string, context: LogContext = {}): void {
    const payload = this.payload(id, context)
    logger.info(payload, `transcode ${id} terminé en ${(payload.totalMs / 1000).toFixed(1)} s`)
  }

  /**
   * Ce que [log] journalise, **sans le journaliser**.
   *
   * Séparé pour que les règles du champ — pas de rapport sans étape mesurée, pas
   * de `encodeFactor` sans encodage — s'éprouvent sur un objet plutôt que sur
   * une sortie de journal capturée. Un test qui n'aurait vérifié que « ça ne
   * lève pas » aurait laissé passer le « ×26730 » qui a motivé cette garde.
   */
  payload(id: string, context: LogContext = {}): Record<string, unknown> & { totalMs: number } {
    const total = Math.round(performance.now() - this.#started)

    // ⚠️ **Aucun rapport au temps réel si rien n'a été traité.**
    //
    // Mesuré en production : le job d'archivage d'une ingestion par URL n'a rien
    // à archiver (l'original vit à son URL), il se réduit au nettoyage — et la
    // ligne annonçait fièrement « ×26730 », c'est-à-dire 5533 s d'audio divisées
    // par 0,2 s de `rm`. Un nombre qui a l'air d'une mesure et n'en est pas est
    // pire que pas de nombre : il se recopie dans un rapport, et il se défend.
    const measured = this.#phases.length > 0
    const audio = measured ? (context.audioSeconds ?? null) : null

    // Le rapport de l'étape qui est en cause, quand elle existe. C'est lui qui
    // départage « la machine est chargée » de « les encodeurs se suivent dans un
    // seul fil » — `totalMs` y mêle l'envoi, qui ne pèse que 5 %.
    const encoding = this.#phases.find(({ phase }) => phase.startsWith('encode'))

    return {
      transcode: id,
      totalMs: total,
      ...(context.regime ? { regime: context.regime } : {}),
      ...(measured ? {} : { note: 'rien à mesurer' }),
      ...(audio ? { audioSeconds: Math.round(audio) } : {}),
      ...(audio ? { realtimeFactor: Number((audio / (total / 1000)).toFixed(1)) } : {}),
      ...(audio && encoding
        ? { encodeFactor: Number((audio / (encoding.ms / 1000)).toFixed(1)) }
        : {}),
      phases: Object.fromEntries(
        this.#phases.map(({ phase, ms, detail }) => [
          phase,
          detail === undefined ? ms : { ms, items: detail },
        ])
      ),
    }
  }
}
