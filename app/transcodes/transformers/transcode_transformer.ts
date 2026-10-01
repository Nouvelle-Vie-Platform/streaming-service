import type Transcode from '#transcodes/models/transcode'
import type { RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'
import type { TranscodeStatus } from '#transcodes/support/transcode_enums'
import { progressFromStatus } from '#transcodes/support/transcode_progress'
import { BaseTransformer } from '@adonisjs/core/transformers'

/**
 * **Le contrat de publication d'un Transcode**, nommé une fois — la forme que
 * servent le `202` d'ingestion, le poll de statut et le SSE, et dont le webhook
 * part pour l'enrichir.
 *
 * Écrit explicitement, et non laissé à l'inférence, pour deux raisons : le champ
 * conditionnel `radioTrack` rend le type inféré difficile à lire, et le firehose
 * d'ops **relit** ce champ pour le relayer — il vaut mieux qu'il s'appuie sur un
 * contrat déclaré que sur ce que le compilateur a bien voulu déduire.
 *
 * Un `type` et non une `interface` : un alias reçoit une signature d'index
 * implicite, donc il reste assignable là où un `Record<string, …>` est attendu.
 */
export type TranscodeWirePayload = {
  id: string
  status: TranscodeStatus
  progress: number | null
  outputPlaylist: string | null
  error: string | null
  /** Présent sur le seul profil `radio`, et seulement à `COMPLETED` (ADR-0010). */
  radioTrack?: RadioTrackInfo
  /**
   * Présent sur le seul profil `sparks`, et seulement à `COMPLETED` (ADR-0011).
   *
   * ⚠️ `outputPlaylist` n'est **pas** `null` sur ce profil : un Spark produit un
   * vrai jeu HLS, et la playlist se lit où elle s'est toujours lue. `sparkMedia`
   * porte ce qui n'y tient pas — la vignette, la forme d'onde, le niveau, les
   * étiquettes — et redit l'URL de la playlist pour qu'un lecteur de ce champ
   * n'ait pas à savoir qu'une moitié de sa réponse est ailleurs.
   */
  sparkMedia?: SparkMedia
}

/**
 * The single wire shape of a Transcode (see Q14 of the design): the upload
 * `202`, the status poll and the SSE payload all serialize through here, so
 * there is exactly one contract to keep in sync.
 *
 * `progress` prefers the live Redis value (passed by the reading layer) and
 * falls back to a value derived from the durable status when Redis is silent —
 * 0 for PENDING, 100 for COMPLETED, null for an in-flight job with no value.
 *
 * ## Les champs conditionnels, et pourquoi ils ne sont pas toujours là
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

  toObject(): TranscodeWirePayload {
    // Une piste radio n'est publiée qu'une fois **servable** : la colonne existe
    // plus tôt que les octets. Voir l'en-tête.
    const radioTrack =
      this.resource.status === 'COMPLETED' ? (this.resource.radioTrack ?? null) : null
    // Même garde, même raison : la colonne existe dès la fin de l'encodage, les
    // octets ne sont servables qu'à `COMPLETED`.
    const sparkMedia =
      this.resource.status === 'COMPLETED' ? (this.resource.sparkMedia ?? null) : null

    return {
      id: this.resource.id,
      status: this.resource.status,
      progress: this.liveProgress ?? progressFromStatus(this.resource.status),
      // Coerced to `null` (not left `undefined`) so the 5-field contract holds
      // whether the model was just created (columns unset in memory) or reloaded.
      outputPlaylist: this.resource.outputPlaylist ?? null,
      error: this.resource.error ?? null,
      ...(radioTrack ? { radioTrack } : {}),
      ...(sparkMedia ? { sparkMedia } : {}),
    }
  }
}
