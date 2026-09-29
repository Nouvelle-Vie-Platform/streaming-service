import Transcode from '#transcodes/models/transcode'
import { DEFAULT_PROFILE } from '#transcodes/support/transcode_enums'
import type { SourceKind, TranscodeProfile } from '#transcodes/support/transcode_enums'
import { fileKind } from '#common/utils/file_agent'

export interface CreateTranscodeParams {
  /** The server-minted UUID v7; the Source on disk is already named after it. */
  id: string
  /** The client file name (or URL basename) — display only, never a disk path. */
  originalFilename: string
  /** Set for URL ingestion: the original stays here, no local copy is kept. */
  sourceUrl?: string
  /** Optional completion-webhook URL; when absent, no webhook is fired (jalon I). */
  callbackUrl?: string
  /** Optional per-upload HMAC secret used to sign the webhook body. */
  callbackSecret?: string
  /**
   * Le profil demandé (issue #46). Absent = `teaching`, le régime historique :
   * une requête qui ne dit rien obtient exactement ce qu'elle obtenait avant.
   */
  profile?: TranscodeProfile
}

/**
 * Creates a Transcode in its initial PENDING state (see CONTEXT.md, ADR-0002).
 *
 * The only layer allowed to touch the model. It derives `source_kind` from the
 * file name via `fileKind()` — the upload validator has already narrowed the
 * extension to the accepted media set, so the kind is always `audio` or
 * `video`. Volatile progress is never written here (Redis owns it).
 */
export class CreateTranscode {
  async execute(params: CreateTranscodeParams): Promise<Transcode> {
    // For a URL ingestion the extension lives in the URL path; otherwise in the
    // uploaded file name. `getExtension` (via fileKind) already strips a query.
    const kindSource = params.sourceUrl ?? params.originalFilename
    const sourceKind: SourceKind = fileKind(kindSource) === 'audio' ? 'audio' : 'video'

    return Transcode.create({
      id: params.id,
      status: 'PENDING',
      originalFilename: params.originalFilename,
      sourceUrl: params.sourceUrl ?? null,
      sourceKind,
      callbackUrl: params.callbackUrl ?? null,
      callbackSecret: params.callbackSecret ?? null,
      profile: params.profile ?? DEFAULT_PROFILE,
    })
  }
}
