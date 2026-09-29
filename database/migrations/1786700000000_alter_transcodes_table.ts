import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'transcodes'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Le profil demandé au dépôt (issue #46) : `teaching` est le régime
      // historique — jeu HLS, trois rendus progressifs, archive FLAC — et
      // `radio` une sortie unique normalisée en niveau.
      //
      // ⚠️ **Le défaut vit ici, dans la base, et pas seulement dans le code.**
      // C'est ce qui garantit que les lignes déjà écrites et tout `INSERT` qui
      // omet la colonne restent dans le régime existant. Une valeur par défaut
      // portée par l'application aurait laissé la colonne `NULL` sur le fonds
      // déjà transcodé, et chaque lecture aurait dû se souvenir de la traduire.
      table
        .enum('profile', ['teaching', 'radio'])
        .notNullable()
        .defaultTo('teaching')

      // La piste radio (issue #46), persistée comme un seul objet JSON :
      // `{ url, bytes, loudness, tags }` — l'URL absolue non signée, la taille
      // mesurée localement, le niveau mesuré par `loudnorm` sur le fichier
      // produit, et les étiquettes lues sur la source.
      //
      // Un blob et non quatre colonnes, pour la raison qui a valu au blob
      // `downloads` : c'est un ensemble toujours écrit et lu d'un bloc, et il
      // épouse la charge utile du webhook au champ près.
      //
      // ⚠️ Écrit **avant** COMPLETED, contrairement à `downloads` : le niveau et
      // les étiquettes sont les sous-produits d'une passe que le point de reprise
      // ne rejouera pas, et la source dont viennent les étiquettes est rendue
      // juste après. Voir `ProcessTranscode`.
      table.jsonb('radio_track').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('profile')
      table.dropColumn('radio_track')
    })
  }
}
