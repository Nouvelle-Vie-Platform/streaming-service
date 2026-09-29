import type Transcode from '#transcodes/models/transcode'
import { progressFromStatus } from '#transcodes/support/transcode_progress'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * The single wire shape of a Transcode (see Q14 of the design): the upload
 * `202`, the status poll and the SSE payload all serialize through here, so
 * there is exactly one contract to keep in sync.
 *
 * `progress` prefers the live Redis value (passed by the reading layer) and
 * falls back to a value derived from the durable status when Redis is silent —
 * 0 for PENDING, 100 for COMPLETED, null for an in-flight job with no value.
 *
 * ## Le sixième champ, et pourquoi il n'est pas toujours là
 *
 * Sur le profil `radio` (ADR-0010) il n'y a **pas de playlist** : `outputPlaylist`
 * vaut `null` à `COMPLETED`, par construction. La sortie est donc publiée sous son
 * propre nom, `radioTrack`, et dans **les trois canaux à la fois** — poll, SSE et
 * webhook — comme l'ADR-0006 l'exige de toute valeur publiée.
 *
 * ⚠️ **Ce n'est pas un ornement, c'est un chemin de rattrapage.** Le portail règle
 * un dépôt depuis le **snapshot de statut** quand un webhook a été perdu (son
 * réconciliateur périodique). Une sortie radio absente du snapshot rendrait un
 * dépôt dont le webhook s'est perdu **définitivement irrécupérable** : il n'y a
 * aucun autre endroit où l'URL, le niveau et les étiquettes pourraient être relus.
 *
 * Deux conditions, et les deux comptent :
 *
 * - **`COMPLETED` seulement.** La ligne porte `radio_track` dès la fin de
 *   l'encodage, avant l'envoi vers RustFS (voir `ProcessTranscode` : le niveau et
 *   les étiquettes sont les sous-produits d'une passe que la reprise ne rejouera
 *   pas). Publier l'URL à `PROCESSING` annoncerait des octets qui ne sont pas
 *   encore servables — exactement ce que l'ADR-0004 interdit en faisant de
 *   `COMPLETED` la promesse « lisible depuis RustFS ».
 * - **Absent, et non `null`, hors de ce profil.** Un enseignement sert au champ
 *   près la forme à cinq champs qu'il a toujours servie ; un champ de plus, même
 *   vide, serait un changement de contrat pour un consommateur qui n'a rien
 *   demandé.
 *
 * Corollaire pour l'appelant : **`outputPlaylist === null` à `COMPLETED` n'est pas
 * une anomalie**, c'est la signature de ce profil. C'est le profil qui dit où
 * regarder — `radioTrack` pour une radio, `outputPlaylist` pour un enseignement.
 */
export default class TranscodeTransformer extends BaseTransformer<Transcode> {
  constructor(
    resource: Transcode,
    private liveProgress?: number | null
  ) {
    super(resource)
  }

  toObject() {
    // Une piste radio n'est publiée qu'une fois **servable** : la colonne existe
    // plus tôt que les octets. Voir l'en-tête.
    const radioTrack =
      this.resource.status === 'COMPLETED' ? (this.resource.radioTrack ?? null) : null

    return {
      id: this.resource.id,
      status: this.resource.status,
      progress: this.liveProgress ?? progressFromStatus(this.resource.status),
      // Coerced to `null` (not left `undefined`) so the 5-field contract holds
      // whether the model was just created (columns unset in memory) or reloaded.
      outputPlaylist: this.resource.outputPlaylist ?? null,
      error: this.resource.error ?? null,
      ...(radioTrack ? { radioTrack } : {}),
    }
  }
}
