/**
 * The lifecycle states, source kinds and profiles of a Transcode (see CONTEXT.md).
 *
 * These unions are referenced by `database/schema_rules.ts` so the schema
 * generator types the `status`, `source_kind` and `profile` columns precisely
 * instead of a bare `string`.
 */
export type TranscodeStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'

export type SourceKind = 'audio' | 'video'

/**
 * **Ce que l'appelant veut qu'on fabrique**, et donc la forme de la sortie.
 *
 * - `teaching` — le régime historique, et le seul que connaissaient les trois
 *   premiers jalons : jeu HLS à trois débits, trois rendus progressifs, archive
 *   FLAC sur le chemin par téléversement. C'est **la valeur par défaut, portée
 *   par la base** (`defaultTo('teaching')`), pour qu'une requête qui ne dit rien
 *   et une ligne écrite avant cette colonne se comportent exactement comme
 *   avant.
 * - `radio` — un fichier unique, à un seul débit, **normalisé en niveau**, que
 *   liquidsoap lit d'un bout à l'autre. Ni HLS (segmenter une chanson de trois
 *   minutes n'apporte rien) ni archive FLAC (le master reste chez l'appelant).
 *
 * C'est un **profil**, pas un état : il est choisi au dépôt et ne change jamais
 * ensuite. Un même fichier redéposé sous l'autre profil est un autre Transcode,
 * avec son propre identifiant et ses propres octets.
 */
export type TranscodeProfile = 'teaching' | 'radio'

/**
 * Le profil d'une requête qui n'en demande pas.
 *
 * Il est répété par la base (`defaultTo`) parce que les deux chemins doivent
 * s'accorder : un `INSERT` qui omet la colonne et une requête qui omet le champ
 * ne peuvent pas décider différemment.
 */
export const DEFAULT_PROFILE: TranscodeProfile = 'teaching'

/** Les profils acceptés par la validation d'une requête d'ingestion. */
export const TRANSCODE_PROFILES: readonly TranscodeProfile[] = ['teaching', 'radio']
