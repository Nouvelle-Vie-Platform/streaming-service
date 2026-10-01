import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'transcodes'

  /**
   * Le profil `sparks` (issue #49) : un troisième régime, et la sortie qu'il
   * publie.
   *
   * ⚠️ **La contrainte doit être rouverte, pas seulement l'union TypeScript.**
   * `table.enum('profile', […])` de la migration précédente a posé une contrainte
   * `CHECK (profile IN ('teaching','radio'))` sur une colonne texte. Ajouter
   * `sparks` au type du code sans y toucher compile, passe les tests qui ne
   * touchent pas la base, et **échoue au premier dépôt réel** — à l'`INSERT`,
   * c'est-à-dire du côté du portail, qui ne saura pas pourquoi.
   *
   * Le défaut, lui, ne bouge pas : il reste `teaching`, posé par la base. Un
   * profil nouveau n'a aucune raison de changer ce qu'obtient une requête qui ne
   * demande rien.
   */
  async up() {
    this.schema.raw(
      `ALTER TABLE ${this.tableName} DROP CONSTRAINT IF EXISTS ${this.tableName}_profile_check`
    )
    this.schema.raw(
      `ALTER TABLE ${this.tableName} ADD CONSTRAINT ${this.tableName}_profile_check ` +
        `CHECK (profile IN ('teaching', 'radio', 'sparks'))`
    )

    this.schema.alterTable(this.tableName, (table) => {
      // Ce qu'un Spark publie (issue #49), persisté comme un seul objet JSON :
      // `{ playlist, poster, hasVideo, durationSeconds, waveform, loudness, tags }`.
      //
      // Un blob et non sept colonnes, pour la raison qui a valu les blobs
      // `downloads` et `radio_track` : c'est un ensemble toujours écrit et lu
      // d'un bloc, et il épouse la charge utile du webhook au champ près.
      //
      // ⚠️ Écrit **avant** COMPLETED, comme `radio_track` et pour la même raison :
      // le niveau, la forme d'onde et les étiquettes sont les sous-produits d'une
      // passe que le point de reprise ne rejouera pas, et la source dont viennent
      // les étiquettes est rendue juste après l'encodage. Les garder en mémoire
      // les perdrait au premier hoquet de RustFS.
      table.jsonb('spark_media').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('spark_media')
    })

    // La colonne se referme sur les deux profils d'avant. Un `sparks` déjà écrit
    // ferait échouer ce retour en arrière, et c'est voulu : il vaut mieux refuser
    // que laisser une ligne violer sa propre contrainte en silence.
    this.schema.raw(
      `ALTER TABLE ${this.tableName} DROP CONSTRAINT IF EXISTS ${this.tableName}_profile_check`
    )
    this.schema.raw(
      `ALTER TABLE ${this.tableName} ADD CONSTRAINT ${this.tableName}_profile_check ` +
        `CHECK (profile IN ('teaching', 'radio'))`
    )
  }
}
