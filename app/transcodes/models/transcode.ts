import { compose } from '@adonisjs/core/helpers'
import { column } from '@adonisjs/lucid/orm'
import { withUuid } from '#common/mixins/with_uuid'
import { TranscodeSchema } from '#database/schema'
import type { DownloadRenditionInfo, RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'

/**
 * The durable state of a Transcode — the source of truth for its lifecycle
 * (see CONTEXT.md and ADR-0001/0002/0004).
 *
 * Columns are inherited from the generated `TranscodeSchema` (regenerated on
 * every `migration:run` by introspecting the database). `withUuid()` layers on
 * the self-assigned UUID v7 primary key that the generator does not emit.
 *
 * Volatile progress lives in Redis, never here: only lifecycle transitions are
 * written to Postgres.
 */
export default class Transcode extends compose(TranscodeSchema, withUuid()) {
  /**
   * The download renditions blob (ADR-0009), overriding the generated column to
   * carry the jsonb round-trip explicitly. `pg` would otherwise format a JS
   * array as a Postgres *array literal* (`{...}`) and the `jsonb` insert fails
   * with "invalid input syntax for type json"; `prepare` serializes to a JSON
   * string on write, and `consume` tolerates a driver that hands back either a
   * parsed value or a raw string on read.
   */
  @column({
    prepare: (value: DownloadRenditionInfo[] | null) =>
      value === null || value === undefined ? value : JSON.stringify(value),
    consume: (value: unknown): DownloadRenditionInfo[] | null => {
      if (value === null || value === undefined) return null
      return (typeof value === 'string' ? JSON.parse(value) : value) as DownloadRenditionInfo[]
    },
  })
  declare downloads: DownloadRenditionInfo[] | null

  /**
   * La piste radio (issue #46), surchargée pour la même raison que `downloads` :
   * rendre explicite l'aller-retour jsonb.
   *
   * Le piège du driver `pg` n'est **pas** le même dans les deux sens ici — un
   * objet JS, lui, est bien sérialisé en JSON (c'est le *tableau* qui devenait un
   * littéral de tableau PostgreSQL et faisait échouer l'insertion). La lecture,
   * en revanche, pose la même question : selon le chemin, le driver rend une
   * valeur déjà décodée ou la chaîne brute. `consume` tolère les deux, et
   * `prepare` reste explicite pour que les deux colonnes jsonb de ce modèle se
   * lisent de la même façon — une discipline, pas deux.
   */
  @column({
    prepare: (value: RadioTrackInfo | null) =>
      value === null || value === undefined ? value : JSON.stringify(value),
    consume: (value: unknown): RadioTrackInfo | null => {
      if (value === null || value === undefined) return null
      return (typeof value === 'string' ? JSON.parse(value) : value) as RadioTrackInfo
    },
  })
  declare radioTrack: RadioTrackInfo | null

  /**
   * La sortie d'un Spark (issue #49), surchargée pour la même raison que les deux
   * précédentes : rendre explicite l'aller-retour jsonb. Trois colonnes jsonb, une
   * seule discipline.
   */
  @column({
    prepare: (value: SparkMedia | null) =>
      value === null || value === undefined ? value : JSON.stringify(value),
    consume: (value: unknown): SparkMedia | null => {
      if (value === null || value === undefined) return null
      return (typeof value === 'string' ? JSON.parse(value) : value) as SparkMedia
    },
  })
  declare sparkMedia: SparkMedia | null
}
