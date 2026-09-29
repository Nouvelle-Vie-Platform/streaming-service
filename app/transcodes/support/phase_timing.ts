import type { TranscodeProfile } from '#transcodes/support/transcode_enums'
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
/**
 * Un rapport « secondes d'audio par seconde passée », **ou rien**.
 *
 * Rien dès que le dénominateur est nul : une étape chronométrée à 0 ms — un
 * double de test, une étape sautée — donnerait `Infinity`, que JSON sérialise en
 * `null`. Un champ à `null` dans un journal se lit comme « la mesure a échoué »
 * et fait chercher une panne là où il n'y avait qu'une division par zéro.
 */
function ratio(name: string, audioSeconds: number | null, ms: number): Record<string, number> {
  if (!audioSeconds || ms <= 0) return {}
  const value = audioSeconds / (ms / 1000)
  return Number.isFinite(value) ? { [name]: Number(value.toFixed(1)) } : {}
}

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
  /**
   * La version de ffmpeg qui a fait le travail.
   *
   * Elle est là pour **expliquer** les facteurs de la même ligne : la passe
   * écrit six sorties, et c'est ffmpeg 7.0 qui a commencé à les encoder en
   * parallèle. Une image reconstruite sur une base plus ancienne diviserait la
   * vitesse par quatre sans rien casser — donc sans rien signaler.
   */
  ffmpeg?: string | null
  /**
   * Le profil de sortie, **quand ce n'est pas le régime historique** (issue #46).
   *
   * Absent pour un enseignement : la ligne citée dans le README doit rester
   * lisible telle quelle. Présent pour une radio, parce que les facteurs de la
   * même ligne n'y veulent alors plus rien dire par comparaison — une seule
   * sortie au lieu de six, et deux décodages au lieu d'un. Sans ce champ, un
   * `×encode` soudain quatre fois meilleur ressemblerait à une amélioration de la
   * machine.
   */
  profile?: TranscodeProfile
}

export class PhaseTimings {
  readonly #started = performance.now()
  readonly #phases: { phase: string; ms: number; items?: number; bytes?: number }[] = []

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
    const items = await run()
    this.#phases.push({ phase, ms: Math.round(performance.now() - at), items })
    return items
  }

  /**
   * Comme [time], en retenant en plus **combien d'octets** l'étape a déplacés.
   *
   * Séparé de [count] parce que les deux se lisent autrement : « 3604 items »
   * désigne des fichiers, et afficher deux milliards d'octets sous le même nom
   * ferait lire deux milliards de fichiers. Le débit se déduit alors de la
   * paire — c'est lui qui dit si un transfert lent est une source énorme ou un
   * lien étroit.
   */
  async bytes(phase: string, run: () => Promise<number>): Promise<number> {
    const at = performance.now()
    const bytes = await run()
    this.#phases.push({ phase, ms: Math.round(performance.now() - at), bytes })
    return bytes
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
      ...(context.ffmpeg ? { ffmpeg: context.ffmpeg } : {}),
      ...(context.profile ? { profile: context.profile } : {}),
      ...(measured ? {} : { note: 'rien à mesurer' }),
      ...(audio ? { audioSeconds: Math.round(audio) } : {}),
      ...ratio('realtimeFactor', audio, total),
      ...ratio('encodeFactor', audio, encoding?.ms ?? 0),
      phases: Object.fromEntries(
        this.#phases.map(({ phase, ms, items, bytes }) => [
          phase,
          items !== undefined
            ? { ms, items }
            : bytes !== undefined
              ? // Le débit avec les octets : sans lui, « 800 s » ne dit pas si
                // la source était énorme ou le lien étroit — et les deux ne se
                // corrigent pas du tout de la même façon.
                { ms, bytes, mbps: ms > 0 ? Number(((bytes * 8) / (ms * 1000)).toFixed(1)) : null }
              : ms,
        ])
      ),
    }
  }
}
