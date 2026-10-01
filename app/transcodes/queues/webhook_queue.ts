import type { TranscodeStatus } from '#transcodes/support/transcode_enums'
import type { DownloadRenditionInfo, RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'
import { queueConnection } from '#config/queue'
import { Queue } from 'bullmq'

/** The BullMQ queue name for completion-webhook delivery; the worker binds to it. */
export const WEBHOOK_QUEUE = 'webhook'

/**
 * The exact body POSTed to the caller. It extends the unified status shape (see
 * `transcode_transformer.ts`) with the two fields the download feature needs
 * pushed rather than polled (ADR-0009): the media `durationSeconds` and, per
 * rendition, its download URL + byte size. COMPLETED carries `outputPlaylist`
 * and a populated `downloads`; FAILED carries `error` and an empty `downloads`.
 */
export interface WebhookPayload {
  id: string
  status: TranscodeStatus
  progress: number | null
  outputPlaylist: string | null
  error: string | null
  /** ffprobe duration in seconds, or null when the media exposes none. */
  durationSeconds: number | null
  /** The progressive download renditions (URL + byte size); empty on FAILED. */
  downloads: DownloadRenditionInfo[]
  /**
   * La piste radio (issue #46) : l'URL unique, sa taille, le **niveau mesuré** et
   * les **étiquettes** de la source.
   *
   * ⚠️ **Absent, et non `null`, hors du profil `radio`.** La charge utile d'un
   * enseignement doit rester exactement celle que l'appelant reçoit aujourd'hui :
   * un champ de plus, même vide, serait un changement de contrat pour un
   * consommateur qui n'a rien demandé. Sur ce profil, `outputPlaylist` vaut
   * `null` et `downloads` est vide — il n'y a ni playlist ni échelle, et le dire
   * en creux est plus honnête que de ranger un fichier `.m4a` dans un champ qui
   * s'appelle « playlist ».
   */
  radioTrack?: RadioTrackInfo
  /**
   * La sortie d'un Spark (issue #49) : l'URL de la playlist, la vignette, la
   * durée, la forme d'onde, le **niveau mesuré** et les **étiquettes**.
   *
   * ⚠️ **Absent, et non `null`, hors du profil `sparks`** — même règle, même
   * raison. Ici, contrairement à la radio, `outputPlaylist` est **rempli** : un
   * Spark produit un vrai jeu HLS. `downloads` reste vide (ADR-0009 : pas de
   * client hors ligne à servir).
   *
   * Déclaré **ici et pas seulement à l'appel** : la charge est construite par un
   * littéral avec étalement conditionnel, et l'étalement échappe au contrôle des
   * propriétés en excès. Un champ publié par le webhook sans être déclaré dans ce
   * type compilerait donc en silence, et le consommateur le découvrirait en
   * production.
   */
  sparkMedia?: SparkMedia
}

/**
 * Everything the delivery worker needs without re-reading the DB: the target
 * URL, the optional per-upload HMAC secret, and the frozen payload to send.
 */
export interface WebhookJobData {
  transcodeId: string
  callbackUrl: string
  callbackSecret?: string
  payload: WebhookPayload
}

/**
 * Producer side of the webhook queue. A singleton (see
 * `providers/webhook_provider.ts`) so its Redis connection is opened once and
 * closed on shutdown. Kept separate from the transcode queue so a flaky caller
 * endpoint never back-pressures the encode workers.
 */
export class WebhookQueue {
  private queue = new Queue<WebhookJobData>(WEBHOOK_QUEUE, { connection: queueConnection })

  /**
   * Enqueues one webhook delivery. Retries generously — the caller may be
   * momentarily down — with exponential backoff so a slow endpoint is not
   * hammered.
   */
  async enqueue(data: WebhookJobData): Promise<void> {
    await this.queue.add('webhook', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
    })
  }

  async close(): Promise<void> {
    await this.queue.close()
  }
}
