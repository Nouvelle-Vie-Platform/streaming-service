import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { readFile, stat } from 'node:fs/promises'
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

/** The variant playlist of one rendition: `<outDir>/<name>/index.m3u8`. */
export function variantPlaylistPath(id: string, name: string): string {
  return join(hlsOutputDir(id), name, 'index.m3u8')
}

/**
 * **Le `master.m3u8`, écrit par nous** — et c'est le fichier le plus exposé du
 * service : tous les téléphones le demandent en premier, et un lecteur qui le
 * lit mal choisit mal, ou ne joue rien.
 *
 * ## Pourquoi nous, et plus ffmpeg
 *
 * Il l'écrivait comme effet de bord de `-var_stream_map`, qui exige que les
 * trois rendus sortent d'une **seule** invocation — donc d'un seul fil, les
 * encodages se suivant. Mesuré : six encodages sérialisés, 6,4× le temps réel
 * là où un flux seul en fait plusieurs dizaines. Un processus par rendu les fait
 * tourner ensemble ; le prix est ce fichier-ci.
 *
 * ## La formule n'est pas inventée, elle est relevée
 *
 * Sur une sortie témoin de ffmpeg (`-var_stream_map`, trois rendus, 14 s de bruit
 * rose), les deux attributs se reproduisent **au nombre près** :
 *
 * - `BANDWIDTH` = le **maximum**, sur les segments, de `octets × 8 / EXTINF` ;
 * - `AVERAGE-BANDWIDTH` = `octets totaux × 8 / durée totale`.
 *
 * Le pic et non la moyenne, parce que c'est ce que la RFC 8216 demande : un
 * lecteur choisit un rendu dont il peut soutenir le **pire** segment. Servir la
 * moyenne ferait bégayer les connexions justes, précisément celles pour
 * lesquelles l'échelle existe.
 *
 * C'est aussi pour cela que les débits **ne sont pas repris de `RENDITIONS`** :
 * `-b:a 64k` est une consigne donnée à l'encodeur, pas une mesure. Le conteneur
 * MPEG-TS ajoute son empaquetage (ici ~11 % sur le rendu bas), et un `BANDWIDTH`
 * sous-évalué est exactement l'erreur qui fait choisir un rendu qu'on ne peut
 * pas suivre.
 *
 * ## Ce qui est recopié à l'identique, sans le comprendre plus loin
 *
 * `#EXT-X-VERSION:6`, l'absence de `#EXT-X-INDEPENDENT-SEGMENTS` dans le master,
 * la ligne vide entre deux variantes, l'ordre des attributs : relevés sur la
 * sortie témoin, et un test les compare à chaque exécution. Le jour où ffmpeg
 * changera de forme, c'est ce test qui le dira — pas un fidèle dont le lecteur
 * reste muet.
 */
export async function buildMasterPlaylist(id: string): Promise<string> {
  const variants = await Promise.all(
    RENDITIONS.map(async (rendition) => {
      const { peak, average } = await measureVariant(id, rendition.name)
      return (
        `#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${average},` +
        `CODECS="${HLS_CODECS}"\n${rendition.name}/index.m3u8\n`
      )
    })
  )

  return `#EXTM3U\n#EXT-X-VERSION:${HLS_VERSION}\n${variants.join('\n')}`
}

/** AAC-LC — ce que `-c:a aac` produit, et ce que ffmpeg annonce. */
const HLS_CODECS = 'mp4a.40.2'

/** La version de playlist que ffmpeg écrit pour cette configuration. */
const HLS_VERSION = 6

/**
 * Le pic et la moyenne d'un rendu, en bits par seconde, **mesurés sur ses
 * fichiers**.
 *
 * La durée vient des `EXTINF` de sa propre playlist et non de `HLS_SEGMENT_SECONDS` :
 * le dernier segment est presque toujours plus court, et c'est lui qui porte
 * souvent le pic (moins d'octets, mais beaucoup moins de secondes).
 */
async function measureVariant(
  id: string,
  name: string
): Promise<{ peak: number; average: number }> {
  const playlist = await readFile(variantPlaylistPath(id, name), 'utf8')
  const lines = playlist.split('\n')

  let totalBytes = 0
  let totalSeconds = 0
  let peak = 0

  for (const [index, line] of lines.entries()) {
    const extinf = /^#EXTINF:([\d.]+)/.exec(line)
    if (!extinf) continue

    const seconds = Number(extinf[1])
    const segment = lines[index + 1]?.trim()
    if (!segment || seconds <= 0) continue

    const { size } = await stat(join(hlsOutputDir(id), name, segment))
    totalBytes += size
    totalSeconds += seconds
    peak = Math.max(peak, (size * 8) / seconds)
  }

  if (totalSeconds === 0) {
    // Une playlist sans segment n'est pas un rendu vide : c'est un encodage qui
    // a échoué sans le dire. Annoncer un débit de zéro produirait un master
    // valide menant à du silence.
    throw new Error(`HLS variant "${name}" of ${id} has no segment — refusing to write a master`)
  }

  return {
    peak: Math.round(peak),
    average: Math.round((totalBytes * 8) / totalSeconds),
  }
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
