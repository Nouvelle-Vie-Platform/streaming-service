import { FindTranscode } from '#transcodes/actions/find_transcode'
import { ProgressStore } from '#transcodes/services/progress_store'
import TranscodeTransformer from '#transcodes/transformers/transcode_transformer'
import { uuidV7 } from '#common/validators/uuid'
import { resolveLang } from '#common/utils/request_lang'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'

/**
 * `GET /transcodes/:id/status` — point-in-time status poll (Q14 of the design).
 *
 * Serves the single wire shape (`id, status, progress, outputPlaylist, error`)
 * via TranscodeTransformer — the very same payload the SSE channel pushes.
 * `status` is read from Postgres (source of truth); `progress` is overlaid with
 * the live Redis value written by the worker, falling back to a status-derived
 * value when Redis is silent.
 *
 * Sur le profil `radio`, la forme gagne un champ `radioTrack` à `COMPLETED`
 * (ADR-0010) : il n'y a pas de playlist à publier, et **ce snapshot est le chemin
 * de rattrapage** d'un appelant dont le webhook s'est perdu. Voir
 * `TranscodeTransformer` pour les deux gardes qui l'encadrent.
 *
 * A malformed id is a 422 (validation); a well-formed but unknown id is a 404.
 */
@inject()
export default class GetTranscodeStatusByIdController {
  constructor(
    private findTranscode: FindTranscode,
    private progressStore: ProgressStore
  ) {}

  private static validator = vine.compile(vine.object({ id: uuidV7() }))

  /**
   * @handle
   * @summary Get a transcode status
   * @operationId getTranscodeStatus
   * @description Return the current state of a Transcode by its id: status,
   * progress, output playlist and error — identical in shape to the SSE payload.
   * On the `radio` profile the payload carries `radioTrack` (url, bytes, measured
   * loudness, source tags) instead of a playlist, and `outputPlaylist` is null.
   * @paramPath id - Transcode UUID v7 - @type(string) @required
   * @responseBody 200 - <Transcode>
   * @responseBody 404 - {"code":"E_TRANSCODE_NOT_EXISTS"}
   * @responseBody 422 - {"code":"E_VALIDATION_ERROR"}
   */
  async handle({ params, request, serialize }: HttpContext) {
    const { id } = await GetTranscodeStatusByIdController.validator.validate({ id: params.id })

    const transcode = await this.findTranscode.execute({ id, lang: resolveLang(request) })
    const progress = await this.progressStore.get(id)

    return serialize(TranscodeTransformer.transform(transcode, progress))
  }
}
