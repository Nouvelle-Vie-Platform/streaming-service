import Transcode from '#transcodes/models/transcode'
import { ArchiveQueue } from '#transcodes/queues/archive_queue'
import { TranscodeQueue } from '#transcodes/queues/transcode_queue'
import { ProgressStore } from '#transcodes/services/progress_store'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { TranscodeInProgressException } from '#transcodes/exceptions/transcode_in_progress_exception'
import {
  archiveKey,
  archivePath,
  downloadKeyPrefix,
  downloadOutputDir,
  hlsKeyPrefix,
  hlsOutputDir,
  radioKeyPrefix,
  radioOutputDir,
} from '#transcodes/support/hls'
import { RessourceNotExistsException } from '#common/exceptions/ressource_not_exists_exception'
import { PlatformLang } from '#common/services/http_service'
import { SourceStore } from '#common/services/source_store'
import { inject } from '@adonisjs/core'
import { rm } from 'node:fs/promises'

export interface DeleteTranscodeParams {
  id: string
  lang?: PlatformLang
}

/**
 * Takes back **everything this service produced** for a Transcode (ADR-0008):
 * the HLS prefix in RustFS, the Archive audio when there is one, the local
 * staging, the residual progress in Redis, and finally the row.
 *
 * The only layer that touches the model. Two rules shape it:
 *
 * 1. **The caller's Source is never touched.** On a URL ingestion the master is
 *    the caller's object and this service has neither the access nor the right
 *    (ADR-0007); there is no archive to remove either, and that absence is not
 *    an error. The only Source it deletes is the copy it staged itself.
 * 2. **Nobody may own it.** Queued jobs are withdrawn first; a job a worker is
 *    holding yields a 409 instead of a half-true deletion (ADR-0008).
 *
 * Every step is forgiving — a missing archive, an empty prefix, an absent Redis
 * key, a job that no longer exists — so re-running converges. The row is
 * deleted **last**: a crash halfway leaves a row that a retry finishes, never
 * orphan bytes that nothing points to.
 */
@inject()
export class DeleteTranscode {
  constructor(
    private rustfs: RustfsStorage,
    private progressStore: ProgressStore,
    private sourceStore: SourceStore,
    private transcodeQueue: TranscodeQueue,
    private archiveQueue: ArchiveQueue
  ) {}

  async execute(params: DeleteTranscodeParams): Promise<void> {
    const lang = params.lang ?? PlatformLang.en

    const transcode = await Transcode.find(params.id)
    if (!transcode) {
      throw new RessourceNotExistsException(lang, 'transcode', params.id)
    }

    // Withdraw before destroying: a job that fires afterwards would re-push HLS
    // (or an archive) into a bucket with no row left to own it.
    if (!(await this.transcodeQueue.withdraw(params.id))) {
      throw new TranscodeInProgressException(lang, params.id)
    }
    if (!(await this.archiveQueue.withdraw(params.id))) {
      throw new TranscodeInProgressException(lang, params.id)
    }

    await this.rustfs.deletePrefix(hlsKeyPrefix(params.id))

    // The `.aac` download renditions ride their own prefix (ADR-0009), produced
    // on both ingestion paths — purge them too, or they outlive their row.
    await this.rustfs.deletePrefix(downloadKeyPrefix(params.id))

    // La piste radio a de même son préfixe (issue #46). **Repris sans regarder le
    // profil** : un préfixe vide n'efface rien et ce n'est pas une erreur, alors
    // qu'une reprise qui se fie à la colonne laisserait des octets servables le
    // jour où la colonne et les octets ne s'accordent pas — exactement ce que
    // l'ADR-0008 reproche à `status`. La reprise est la seule chose qui doit
    // être vraie dans tous les cas.
    await this.rustfs.deletePrefix(radioKeyPrefix(params.id))

    // An Archive audio exists only on the upload path (ADR-0007). Prefer the
    // recorded key, and fall back to the deterministic one so an archive whose
    // job pushed the FLAC without yet recording it is still reclaimed.
    if (!transcode.sourceUrl) {
      await this.rustfs.deleteObject(transcode.archiveKey ?? archiveKey(params.id))
    }

    // Local staging: whatever the pipeline has not yet reclaimed (ADR-0004) —
    // a PENDING deposit still holds its whole Source on disk.
    await rm(hlsOutputDir(params.id), { recursive: true, force: true })
    await rm(downloadOutputDir(params.id), { recursive: true, force: true })
    await rm(radioOutputDir(params.id), { recursive: true, force: true })
    await rm(archivePath(params.id), { force: true })
    await this.sourceStore.removeFor(params.id)

    await this.progressStore.clear(params.id)

    await transcode.delete()
  }
}
