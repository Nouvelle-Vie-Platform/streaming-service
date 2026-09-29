import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { join } from 'node:path'

/** One AAC-LC quality of the HLS output (see CONTEXT.md, ADR-0001). */
export interface Rendition {
  name: string
  bitrate: string
}

/**
 * One progressive download rendition as it is **persisted** on the Transcode row
 * and **published** in the completion webhook (ADR-0009): the ladder rung name,
 * its absolute unsigned public URL, and the byte size measured locally at encode
 * time. The single shape the model column, the webhook payload and the
 * `ProcessTranscode` result all speak, so there is one contract to keep in sync.
 * No bitrate field — the ladder stays implicit (ADR-0001).
 */
export interface DownloadRenditionInfo {
  /** `low` | `mid` | `high` — the ladder rung (ADR-0001). */
  name: string
  /** The absolute, unsigned, versioned URL on the public origin (ADR-0006/0009). */
  url: string
  /** The `.aac` file size in bytes (measured locally, no `HEAD`). */
  bytes: number
}

/**
 * The fixed 3-rung ladder. 64 kbps is the floor — below it worship music
 * degrades audibly (see the design, Q7).
 */
export const RENDITIONS: readonly Rendition[] = [
  { name: 'low', bitrate: '64k' },
  { name: 'mid', bitrate: '128k' },
  { name: 'high', bitrate: '192k' },
]

/** Target segment length in seconds. */
export const HLS_SEGMENT_SECONDS = 6

/**
 * The container/codec of the progressive **download** renditions (ADR-0009).
 *
 * Isolated in one place so the spike #183 fallback — a move from AAC/ADTS to
 * MP3 should a device test ever fail — stays a local edit here and never leaks
 * into `buildArgs`, the upload content-type or the key layout. ADTS is chosen
 * because any prefix of the file is valid audio (no central index), so the
 * client can play a half-downloaded file.
 */
export const DOWNLOAD_FORMAT = {
  /** ffmpeg muxer (`-f`). ADTS = raw AAC frames, so any byte prefix decodes. */
  container: 'adts',
  /** ffmpeg audio codec (`-c:a`). */
  codec: 'aac',
  /** Extension the renditions carry on disk and in their public key. */
  extension: 'aac',
  /** Content-type set on upload and served by the origin. */
  contentType: 'audio/aac',
} as const

/** Local staging root for a Transcode's HLS output and FLAC archive. */
export function hlsOutputDir(id: string): string {
  return app.makePath('storage/hls', id)
}

/** The master playlist on local disk — its presence marks "already encoded". */
export function masterPlaylistPath(id: string): string {
  return join(hlsOutputDir(id), 'master.m3u8')
}

/**
 * La copie locale d'une source **distante**, le temps de l'encoder.
 *
 * Hors du dossier HLS et hors de celui des téléchargements, comme l'archive :
 * ces deux-là sont poussés en entier vers RustFS, et la source n'a rien à y
 * faire. Elle porte l'identifiant du transcodage, donc deux jobs simultanés ne
 * se marchent pas dessus.
 *
 * `.bin` sans plus de précision : ffmpeg reconnaît le conteneur à ses octets, et
 * une extension devinée depuis une URL présignée serait un mensonge poli.
 */
export function stagedSourcePath(id: string): string {
  return app.makePath('storage/sources', `${id}.bin`)
}

/**
 * The lossless audio archive (FLAC) on local disk, pushed to RustFS in jalon G.
 * Kept **outside** the HLS output dir so it is never swept into the HLS upload
 * — the archive is conservation, not diffusion.
 */
export function archivePath(id: string): string {
  return app.makePath('storage/archives', `${id}.flac`)
}

/**
 * The RustFS key prefix the HLS output is pushed to and served from. The upload
 * and the delete both derive their keys from here: the only way to be sure a
 * deletion targets exactly what the publication wrote is to name it once.
 */
export function hlsKeyPrefix(id: string): string {
  return `hls/${id}`
}

/**
 * The RustFS key of the FLAC Archive audio. Deterministic, so a deletion can
 * aim at it even when the archive job has not yet recorded `archive_key` on the
 * row. **Upload path only** — a URL ingestion produces no archive (ADR-0007).
 */
export function archiveKey(id: string): string {
  return `archives/${id}.flac`
}

/**
 * The client-facing playlist URL stored on the Transcode and published in every
 * channel. **Absolute** (ADR-0006): `<HLS_PUBLIC_BASE_URL>/hls/<id>/master.m3u8`.
 * The base is the public front door (Caddy/CDN), not the internal RustFS origin;
 * the service says *where*, so callers never recompose the path.
 */
export function outputPlaylistUrl(id: string): string {
  const base = env.get('HLS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  return `${base}/hls/${id}/master.m3u8`
}

/**
 * Local staging dir for the progressive download renditions (ADR-0009). Kept
 * **outside** the HLS output dir — like the FLAC archive — so the HLS upload
 * (`uploadDirectory`) never sweeps the `.aac` in with the wrong content-type or
 * key. They ride their own `dl/<id>/` prefix instead.
 */
export function downloadOutputDir(id: string): string {
  return app.makePath('storage/dl', id)
}

/** The local path of one download rendition, e.g. `.../<id>/low.aac`. */
export function downloadRenditionPath(id: string, name: string): string {
  return join(downloadOutputDir(id), `${name}.${DOWNLOAD_FORMAT.extension}`)
}

/**
 * The RustFS key prefix the download renditions are pushed to and served from:
 * `dl/<id>`. Upload and delete both derive their keys from here (same discipline
 * as `hlsKeyPrefix`), and the `<id>` makes every re-transcode a **new URL**, so
 * a download resumed days later with `Range` can never splice a different
 * version's bytes (ADR-0009).
 */
export function downloadKeyPrefix(id: string): string {
  return `dl/${id}`
}

/** The RustFS key of one download rendition: `dl/<id>/<name>.aac`. */
export function downloadRenditionKey(id: string, name: string): string {
  return `${downloadKeyPrefix(id)}/${name}.${DOWNLOAD_FORMAT.extension}`
}

/**
 * The absolute public URL of one download rendition (ADR-0006/0009), on the same
 * public origin as the HLS: `<HLS_PUBLIC_BASE_URL>/dl/<id>/<name>.aac`.
 * **Unsigned** — a signed URL would expire mid-pause and break "resume days
 * later" with a 403.
 */
export function downloadRenditionUrl(id: string, name: string): string {
  const base = env.get('HLS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  return `${base}/${downloadRenditionKey(id, name)}`
}

/**
 * The ffmpeg output arguments for the three progressive download renditions
 * (ADR-0009): one mapped output per rung of the ladder, decoded from the **same**
 * source read as the HLS and FLAC (no second pass). Each is
 * `-map 0:a:0 -c:a aac -b:a <bitrate> -f adts <id>/<name>.aac`.
 */
export function downloadOutputArgs(id: string): string[] {
  return RENDITIONS.flatMap((rendition) => [
    '-map',
    '0:a:0',
    '-c:a',
    DOWNLOAD_FORMAT.codec,
    '-b:a',
    rendition.bitrate,
    '-f',
    DOWNLOAD_FORMAT.container,
    downloadRenditionPath(id, rendition.name),
  ])
}
