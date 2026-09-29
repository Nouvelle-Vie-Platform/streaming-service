import { CreateTranscode } from '#transcodes/actions/create_transcode'
import { TRANSCODE_PROFILES } from '#transcodes/support/transcode_enums'
import { TranscodeQueue } from '#transcodes/queues/transcode_queue'
import TranscodeTransformer from '#transcodes/transformers/transcode_transformer'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { v7 as uuidv7 } from 'uuid'
import vine from '@vinejs/vine'

/**
 * `POST /transcodes` — ingest a Source by **URL** instead of uploading it.
 *
 * The caller passes a full, fetchable URL (e.g. an S3 object). ffmpeg reads it
 * directly, so nothing is staged or archived locally and the original is never
 * re-stored — the URL is recorded as the master (ADR-0004). Everything after is
 * identical to an upload: same PENDING → COMPLETED lifecycle, same HLS in RustFS,
 * same 202 contract and same notifications.
 *
 * **C'est le seul point d'entrée qui accepte un profil** (issue #46) : le portail
 * n'appelle que celui-ci — il range le média dans RustFS et nous en remet une URL
 * présignée. `POST /upload` reste volontairement au régime des enseignements ;
 * lui ouvrir la radio aurait ajouté un chemin que personne n'emprunte, et une
 * archive FLAC à interdire de plus.
 */
@inject()
export default class IngestUrlController {
  constructor(
    private createTranscode: CreateTranscode,
    private transcodeQueue: TranscodeQueue
  ) {}

  private static validator = vine.create({
    sourceUrl: vine
      .string()
      .url({ require_protocol: true, protocols: ['http', 'https'] })
      .maxLength(2048),
    callbackUrl: vine
      .string()
      .url({ require_protocol: true, protocols: ['http', 'https'] })
      .maxLength(2048)
      .optional(),
    callbackSecret: vine.string().maxLength(512).optional(),
    /**
     * Le profil de sortie (issue #46). Facultatif : absent, c'est le régime des
     * enseignements, inchangé. `radio` produit une sortie unique normalisée en
     * niveau, sans HLS ni archive.
     */
    profile: vine.enum(TRANSCODE_PROFILES).optional(),
  })

  /**
   * @handle
   * @summary Ingest a source by URL
   * @operationId ingestUrl
   * @description Create an audio-HLS Transcode from a full source URL (e.g. S3).
   * ffmpeg reads the URL directly — no local copy, no FLAC archive; the URL is
   * kept as the master. Responds 202 with the created Transcode; media validation
   * (a decodable audio track) happens asynchronously in the worker.
   * Un `profile` optionnel choisit la forme de la sortie : `teaching` (défaut,
   * le jeu HLS) ou `radio` (une seule piste normalisée en niveau, ADR-0010).
   * @requestBody {"sourceUrl":"https://bucket.example.com/audio.mp3","profile":"radio"}
   * @responseBody 202 - <Transcode>
   * @responseBody 422 - {"code":"E_VALIDATION_ERROR"}
   */
  async handle({ request, response, serialize }: HttpContext) {
    const { sourceUrl, callbackUrl, callbackSecret, profile } = await request.validateUsing(
      IngestUrlController.validator
    )

    const id = uuidv7()
    const transcode = await this.createTranscode.execute({
      id,
      originalFilename: urlBasename(sourceUrl),
      sourceUrl,
      callbackUrl,
      callbackSecret,
      profile,
    })

    await this.transcodeQueue.enqueue({
      id,
      source: sourceUrl,
      sourceKind: transcode.sourceKind,
      remote: true,
      // Le profil voyage avec le job pour que le worker n'ait pas à relire la
      // base — c'est la raison d'être de `TranscodeJobData`.
      profile: transcode.profile,
    })

    response.status(202)
    return serialize(TranscodeTransformer.transform(transcode))
  }
}

/** The last path segment of a URL, for admin display only. */
function urlBasename(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop()
    return name ? decodeURIComponent(name) : 'source'
  } catch {
    return 'source'
  }
}
