import Transcode from '#transcodes/models/transcode'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { archiveKey, archivePath, downloadOutputDir, hlsOutputDir } from '#transcodes/support/hls'
import { PhaseTimings } from '#transcodes/support/phase_timing'
import { inject } from '@adonisjs/core'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export interface ArchiveTranscodeParams {
  id: string
  source: string
  remote: boolean
}

/**
 * Second-stage finalization (ADR-0004): **encode** the FLAC archive (uploads
 * only), push it to RustFS, record its key, then reclaim local disk — the HLS
 * staging dir and, for an upload, the local FLAC and Source.
 *
 * For a **URL** ingestion there is no local Source and no FLAC: the original
 * already lives at the URL (recorded as `source_url`), so this step only clears
 * the HLS staging. Runs after COMPLETED (the HLS is already in RustFS); the
 * archive is confirmed **before** anything local is removed. Idempotent.
 *
 * ## C'est ici que le FLAC est encodé, désormais
 *
 * Il l'était dans la passe principale, « depuis un seul décodage ». La mesure
 * des phases a montré le prix : l'encodage fait 94 % d'un transcodage et tourne
 * dans un **seul fil**, si bien que le FLAC retardait le moment où
 * l'enseignement devient écoutable — pour un fichier de conservation que
 * personne n'attend. Il a rejoint le job qui le pousse déjà.
 *
 * **Le rattrapage reste gratuit tant que le fichier est là.** Un échec de RustFS
 * retente sans ré-encoder : le FLAC n'est effacé qu'à la toute fin, après la
 * confirmation. Seul un échec **pendant** l'encodage refait l'encodage — ce qui
 * est exactement ce qu'on veut.
 */
@inject()
export class ArchiveTranscode {
  constructor(
    private rustfs: RustfsStorage,
    private transcoder: FfmpegTranscoder
  ) {}

  async execute(params: ArchiveTranscodeParams): Promise<void> {
    const transcode = await Transcode.find(params.id)
    if (!transcode) return

    const timings = new PhaseTimings()

    if (!params.remote) {
      // Déjà là = un rejeu après un envoi refusé. Ré-encoder coûterait autant
      // que la première fois pour produire octet pour octet le même fichier.
      if (!existsSync(archivePath(params.id))) {
        await timings.time('encodeArchive', () =>
          this.transcoder.encodeArchive(params.source, params.id)
        )
      }

      const key = archiveKey(params.id)
      await timings.time('uploadArchive', () => this.rustfs.uploadFile(archivePath(params.id), key))
      transcode.archiveKey = key
      await transcode.save()
    }

    // The HLS and the `.aac` download renditions already serve from RustFS:
    // reclaim their local staging (ADR-0009 — the `.aac` are produced on both
    // paths). For an upload, also drop the local FLAC and Source.
    await rm(hlsOutputDir(params.id), { recursive: true, force: true })
    await rm(downloadOutputDir(params.id), { recursive: true, force: true })
    if (!params.remote) {
      await rm(archivePath(params.id), { force: true })
      await rm(params.source, { force: true })
    }

    // Une ligne pour ce job aussi : c'est elle qui dira ce que le FLAC coûtait
    // réellement dans la passe principale — le chiffre qui manquait pour
    // trancher la suite (faut-il aussi paralléliser les trois AAC ?).
    timings.log(params.id, { audioSeconds: transcode.durationSeconds, regime: 'archive' })
  }
}
