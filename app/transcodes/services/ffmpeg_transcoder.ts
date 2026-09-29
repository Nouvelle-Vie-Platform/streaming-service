import {
  RENDITIONS,
  HLS_SEGMENT_SECONDS,
  RADIO_LOUDNESS,
  hlsOutputDir,
  archivePath,
  downloadOutputDir,
  downloadOutputArgs,
  downloadRenditionPath,
  radioAnalysisArgs,
  radioOutputArgs,
  radioOutputDir,
  radioTrackPath,
} from '#transcodes/support/hls'
import type { LoudnessMeasurement, RadioLoudness } from '#transcodes/support/hls'
import { NO_TAGS, readTags } from '#transcodes/support/media_tags'
import type { MediaTags } from '#transcodes/support/media_tags'
import { execFile, spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProbeResult {
  /** Media duration in seconds, or `null` when ffprobe exposes none (Q16). */
  durationSeconds: number | null
  /** Whether the container carries at least one decodable audio track. */
  hasAudio: boolean
  /**
   * Le débit du conteneur en bits par seconde, ou `null` quand la sonde n'en
   * annonce pas (un flux sans en-tête de débit rend `N/A`).
   *
   * Lu sur le **conteneur** et non sur la piste : c'est le chiffre que
   * l'administrateur reconnaîtra du fichier qu'il a déposé, et le seul que tous
   * les formats annoncent.
   */
  bitrate: number | null
  /**
   * Les étiquettes de la source — titre, artiste, album — quand elle en porte
   * (issue #46). Toujours un objet, jamais `undefined` : c'est chaque champ qui
   * est nullable, parce qu'un fichier peut porter un titre sans album.
   */
  tags: MediaTags
}

/**
 * One progressive download rendition produced by the pass (ADR-0009), with its
 * **byte size measured locally before upload**. The caller (issue #186) needs the
 * exact size for the client's progress bar, resume validation and disk pre-check,
 * and a `HEAD` round-trip per file is the thing we are avoiding — so the encoder
 * hands the sizes up rather than making the caller ask RustFS.
 *
 * `name` matches a `Rendition.name` (`low`/`mid`/`high`), so #186 pairs each size
 * with its public URL via `downloadRenditionUrl(id, name)`.
 */
export interface DownloadRendition {
  name: string
  bitrate: string
  bytes: number
}

/** What one encode pass produced besides the HLS (returned for issue #186). */
export interface EncodeResult {
  downloads: DownloadRendition[]
}

/**
 * Ce que la passe radio a produit (issue #46) : la taille du fichier unique,
 * mesurée localement comme celle des rendus progressifs, et le **niveau
 * mesuré** — que `loudnorm` calcule sur le résultat pendant qu'il l'écrit, donc
 * sans un décodage de plus.
 */
export interface RadioEncodeResult {
  bytes: number
  loudness: RadioLoudness | null
}

/**
 * Le bloc JSON que `loudnorm=print_format=json` imprime sur stderr, ou `null`.
 *
 * Il n'a aucune imbrication, d'où la recherche par accolades plates ; on retient
 * le **dernier** bloc, parce qu'un graphe de filtres peut en imprimer plusieurs
 * et que le nôtre est le dernier à se vider.
 */
function parseLoudnormReport(stderr: string): Record<string, string> | null {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g)
  if (!blocks || blocks.length === 0) return null
  try {
    return JSON.parse(blocks[blocks.length - 1]) as Record<string, string>
  } catch {
    return null
  }
}

/**
 * Un champ du rapport en nombre, ou `null`.
 *
 * ⚠️ **`-inf` n'est pas un nombre.** Sur une source silencieuse, `loudnorm`
 * imprime `"input_i": "-inf"` : `Number()` en fait `-Infinity`, que `JSON`
 * sérialise en `null` et que le filtre refuserait en `measured_I`. On le traite
 * donc comme une absence de mesure, ici, une fois, plutôt que de laisser un
 * `-Infinity` voyager jusqu'à la base.
 */
function reportNumber(report: Record<string, string>, key: string): number | null {
  const value = Number(report[key])
  return Number.isFinite(value) ? value : null
}

/**
 * Thin wrapper over the system `ffprobe`/`ffmpeg` binaries (see the design, Q7/Q8).
 *
 * The **serving** encode is a single ffmpeg invocation reading the source once
 * and writing, from that one read: the three HLS renditions with a master
 * playlist, and the three progressive `.aac` download renditions (ADR-0009) —
 * so `-progress`'s `out_time_us` runs 0→duration exactly once and the percentage
 * formula holds. Video is discarded (`-vn`, ADR-0001).
 *
 * ## L'archive FLAC a sa propre passe, et ce n'est pas un oubli
 *
 * Elle était produite dans la même invocation, « depuis un seul décodage ». La
 * mesure des phases a montré ce que cette économie coûtait : l'encodage occupe
 * **94 % du temps** d'un transcodage, et il est **sérialisé dans un seul fil** —
 * un sermon d'1 h 47 est sorti à 6,4× le temps réel, là où un seul flux AAC en
 * fait plusieurs dizaines. Les quatre encodeurs se suivent au lieu de tourner
 * ensemble.
 *
 * Or l'archive n'est **utile à personne avant `COMPLETED`** : le job qui la
 * pousse s'exécute déjà après. La garder dans la passe principale retardait donc
 * le moment où l'enseignement devient écoutable, pour un fichier de conservation
 * que nul n'attend. Elle passe dans {@link encodeArchive}, appelée par
 * `ArchiveTranscode`.
 *
 * Le prix assumé : **la source est décodée deux fois**. Le décodage est la part
 * bon marché du travail, et la seconde a lieu dans un job de fond où plus
 * personne ne compte les secondes.
 *
 * ## Le profil « radio » passe ailleurs
 *
 * Un titre destiné à l'antenne ne prend ni {@link encode} ni {@link encodeArchive} :
 * il prend {@link measureLoudness} puis {@link encodeRadio} — une seule sortie, un
 * seul débit, **normalisée en niveau**. Les deux régimes ne partagent aucun
 * argument ffmpeg, volontairement : celui des enseignements ne doit pas bouger
 * d'un token parce qu'une radio est arrivée.
 */
export class FfmpegTranscoder {
  /** Mémorisé : la version ne change pas pendant la vie du processus. */
  #version: string | null | undefined

  /**
   * La version de ffmpeg, telle qu'il l'annonce — ou `null` s'il ne répond pas.
   *
   * Elle voyage dans la ligne de mesure parce qu'elle **explique** le chiffre qui
   * l'accompagne : cette passe écrit six sorties, et c'est ffmpeg 7.0 qui a
   * commencé à les encoder en parallèle, un fil par sortie. Sous 5.1 elles se
   * suivaient — 6,1× le temps réel contre 54,8× pour un encodage seul sur la
   * même machine.
   *
   * Sans ce champ, une image reconstruite un jour sur une base plus ancienne
   * diviserait la vitesse par quatre **en silence** : rien ne casse, les sermons
   * sortent, ils sortent simplement quatre fois plus tard.
   */
  async version(): Promise<string | null> {
    if (this.#version !== undefined) return this.#version

    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-version'])
      this.#version = /^ffmpeg version (\S+)/.exec(stdout)?.[1] ?? null
    } catch {
      // Une mesure n'a pas à faire échouer le travail qu'elle observe.
      this.#version = null
    }

    return this.#version
  }

  /**
   * Ce que le conteneur dit de lui-même, en un seul appel : une piste audio ou
   * non, la durée, le **débit** et les **étiquettes** (issue #46).
   *
   * Tout est demandé d'un coup parce que le JSON était déjà parsé ici : chaque
   * champ de plus coûte une clé dans `-show_entries`, pas un aller-retour.
   *
   * ⚠️ **Les étiquettes se lisent à deux niveaux.** `format_tags` porte celles
   * d'un MP4 ou d'un MP3, `stream_tags` celles d'un Ogg. Ne demander que le
   * premier perdrait les secondes en silence — voir `readTags`, qui tranche aussi
   * la casse des clés.
   */
  async probe(sourcePath: string): Promise<ProbeResult> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration,bit_rate:format_tags:stream=codec_type:stream_tags',
      '-of',
      'json',
      sourcePath,
    ])

    const data = JSON.parse(stdout) as {
      streams?: { codec_type?: string; tags?: Record<string, string> }[]
      format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> }
    }

    const streams = data.streams ?? []
    const audio = streams.find((stream) => stream.codec_type === 'audio')
    const hasAudio = audio !== undefined
    const duration = data.format?.duration ? Number(data.format.duration) : Number.NaN
    const bitrate = data.format?.bit_rate ? Number(data.format.bit_rate) : Number.NaN

    return {
      hasAudio,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      bitrate: Number.isFinite(bitrate) ? bitrate : null,
      // Une source sans piste audio n'a pas d'étiquettes à proposer : le job va
      // échouer de façon permanente juste après (ADR-0001).
      tags: hasAudio ? readTags(data.format?.tags, audio.tags) : NO_TAGS,
    }
  }

  /**
   * **Passe 1 sur 2 de la normalisation** (issue #46) : décoder la source et
   * laisser `loudnorm` mesurer son niveau, sans rien écrire.
   *
   * ## Pourquoi deux passes, et non une
   *
   * En une passe, `loudnorm` normalise **dynamiquement** : il ne connaît pas
   * encore le morceau, donc son gain varie au fil de la lecture. Le niveau moyen
   * sort juste, mais une intro calme est poussée et un refrain fort est retenu —
   * autrement dit le filtre **retouche l'intérieur** des titres. Or ce n'est pas
   * ce qu'on lui demande : ce qui s'entend d'une antenne amateur, c'est l'écart
   * *entre* deux titres, pas la dynamique *dans* un titre.
   *
   * La mesure préalable permet le mode `linear` : **un gain constant**, décidé
   * une fois, appliqué partout. Les dynamiques du morceau sont intactes et la
   * discothèque entière se retrouve au même niveau.
   *
   * ## Ce que la seconde passe coûte
   *
   * Un **décodage**, pas un encodage : cette passe écrit dans `/dev/null`. Le
   * dépôt a déjà accepté un second décodage pour l'archive FLAC, et l'en-tête de
   * cette classe dit pourquoi c'est tenable — « le décodage est la part bon
   * marché du travail », l'encodage pesant 94 % d'un transcodage. La différence
   * avec l'archive est que celui-ci est sur le chemin critique : il retarde le
   * moment où le titre est diffusable.
   *
   * ⚠️ **Le chiffre manque.** Aucune mesure n'a été prise pour ce choix — la
   * tranche a été écrite sans exécuter ffmpeg. C'est pourquoi la phase est
   * chronométrée sous son propre nom (`analyseLoudness`) dans
   * `ProcessTranscode` : le premier titre encodé en production donnera le rapport
   * analyse/encodage dans la ligne de journal, et ce choix pourra être défendu ou
   * défait sur un nombre. En attendant, il est justifié par la **qualité**
   * (gain constant contre gain variable), pas par la vitesse.
   *
   * Rend `null` quand la mesure n'est pas exploitable (une source silencieuse
   * rend `-inf`) : la passe d'application retombe alors sur le mode dynamique
   * plutôt que d'échouer. Un titre normalisé approximativement vaut mieux qu'un
   * job en échec.
   */
  async measureLoudness(source: string): Promise<LoudnessMeasurement | null> {
    const stderr = await this.#run(radioAnalysisArgs(source), { label: 'analyse' })
    const report = parseLoudnormReport(stderr)
    if (!report) return null

    const i = reportNumber(report, 'input_i')
    const tp = reportNumber(report, 'input_tp')
    const lra = reportNumber(report, 'input_lra')
    const thresh = reportNumber(report, 'input_thresh')
    const targetOffset = reportNumber(report, 'target_offset')

    if (i === null || tp === null || lra === null || thresh === null || targetOffset === null) {
      return null
    }

    return { i, tp, lra, thresh, targetOffset }
  }

  /**
   * **Passe 2 sur 2** : la sortie radio unique (issue #46) — un seul fichier, au
   * débit unique de `RADIO_FORMAT`, normalisé avec la mesure de
   * {@link measureLoudness}. Ni HLS, ni rendus progressifs, ni FLAC.
   *
   * `onProgress` reçoit un pourcentage entier (0-99) comme pour la passe de
   * service ; il n'est pas appelé quand la durée est inconnue.
   *
   * Rend la taille du fichier **et le niveau mesuré** : `loudnorm` imprime, à la
   * fin de cette même passe, la loudness du résultat. C'est donc une mesure du
   * fichier produit, pas une prédiction — et elle n'a coûté aucun décodage
   * supplémentaire.
   */
  async encodeRadio(
    source: string,
    id: string,
    measured: LoudnessMeasurement | null,
    durationSeconds: number | null,
    onProgress: (percent: number) => void
  ): Promise<RadioEncodeResult> {
    await mkdir(radioOutputDir(id), { recursive: true })

    const stderr = await this.#run(
      [
        '-hide_banner',
        '-y',
        '-i',
        source,
        '-vn',
        '-progress',
        'pipe:1',
        '-nostats',
        ...radioOutputArgs(id, measured),
      ],
      { label: 'radio', durationSeconds, onProgress }
    )

    const report = parseLoudnormReport(stderr)
    const { size } = await stat(radioTrackPath(id))

    return { bytes: size, loudness: report ? this.#loudness(report) : null }
  }

  /**
   * La taille de la piste radio déjà sur le disque, pour le point de reprise —
   * le pendant de {@link measureDownloads}.
   *
   * Seule la taille : le **niveau** et les **étiquettes** ne se retrouvent pas
   * sur un fichier déjà écrit (les étiquettes vivaient sur la source, qui a été
   * rendue), donc ils sont persistés dès que la passe les produit. Voir
   * `ProcessTranscode`.
   */
  async measureRadioTrack(id: string): Promise<number> {
    const { size } = await stat(radioTrackPath(id))
    return size
  }

  /** Le rapport de `loudnorm` en niveau publiable, ou `null` s'il est muet. */
  #loudness(report: Record<string, string>): RadioLoudness | null {
    const inputI = reportNumber(report, 'input_i')
    const outputI = reportNumber(report, 'output_i')
    // Sans la loudness d'entrée et celle de sortie, il n'y a pas de mesure :
    // publier le reste laisserait croire à une vérification qui n'a pas eu lieu.
    if (inputI === null || outputI === null) return null

    return {
      targetI: RADIO_LOUDNESS.targetI,
      inputI,
      inputTp: reportNumber(report, 'input_tp') ?? 0,
      inputLra: reportNumber(report, 'input_lra') ?? 0,
      outputI,
      outputTp: reportNumber(report, 'output_tp') ?? 0,
      outputLra: reportNumber(report, 'output_lra') ?? 0,
      normalization: report.normalization_type ?? 'unknown',
    }
  }

  /**
   * Lance ffmpeg et rend **sa sortie d'erreur**, où `loudnorm` imprime sa mesure.
   *
   * Partagé par les deux passes radio seulement : `encode` et `encodeArchive`
   * gardent leur propre `spawn`, à l'identique. Les rapprocher aurait été un
   * refactor du régime des enseignements, que cette tranche n'a pas le droit de
   * faire bouger — et il n'a pas besoin de la queue élargie ni du rapport.
   */
  async #run(
    args: string[],
    options: {
      label: string
      durationSeconds?: number | null
      onProgress?: (percent: number) => void
    }
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = spawn('ffmpeg', args)

      // Une queue large, et non les 2000 caractères des autres passes : le
      // rapport JSON de `loudnorm` est imprimé en dernier mais ffmpeg peut le
      // faire suivre d'avertissements de muxage, et un rapport tronqué est un
      // rapport perdu.
      let stderr = ''
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16_000)
      })

      // Sortis de l'écouteur : la progression n'a de sens que si la durée est
      // connue, et `-progress` n'est même pas demandé par la passe d'analyse.
      const { onProgress, durationSeconds } = options
      let buffer = ''
      let lastPercent = 0
      proc.stdout.on('data', (chunk) => {
        if (!onProgress || !durationSeconds) return
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const match = line.match(/^out_time_us=(\d+)/)
          if (!match) continue
          const percent = Math.min(
            99,
            Math.floor((Number(match[1]) / (1_000_000 * durationSeconds)) * 100)
          )
          if (percent > lastPercent) {
            lastPercent = percent
            onProgress(percent)
          }
        }
      })

      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve(stderr)
        else {
          const tail = stderr.slice(-2000)
          reject(new Error(`ffmpeg (${options.label}) exited with code ${code}: ${tail}`))
        }
      })
    })
  }

  /**
   * Encodes the source (a local path or a remote URL — ffmpeg reads both) into
   * local HLS **and** the three progressive `.aac` download renditions (ADR-0009,
   * produced on both ingestion paths — they are a serving artefact, not an
   * archival one). The lossless FLAC master is **no longer written here**: see
   * {@link encodeArchive} and the class header. `onProgress` gets an integer
   * percentage (0-99) as ffmpeg advances; it is not called when the duration is
   * unknown.
   *
   * Returns the download renditions with their **locally measured byte sizes**,
   * so the caller (#186) can persist and publish them without a `HEAD` per file.
   */
  async encode(
    source: string,
    id: string,
    durationSeconds: number | null,
    onProgress: (percent: number) => void
  ): Promise<EncodeResult> {
    const outDir = hlsOutputDir(id)
    await mkdir(outDir, { recursive: true })
    for (const rendition of RENDITIONS) {
      await mkdir(join(outDir, rendition.name), { recursive: true })
    }
    // The `.aac` download renditions live outside the HLS dir (see hls.ts) so the
    // HLS upload never sweeps them — ensure their staging dir exists.
    await mkdir(downloadOutputDir(id), { recursive: true })

    const args = this.buildArgs(source, id, outDir)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args)

      let stderrTail = ''
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })

      let buffer = ''
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const match = line.match(/^out_time_us=(\d+)/)
          if (match && durationSeconds) {
            const percent = Math.min(
              99,
              Math.floor((Number(match[1]) / (1_000_000 * durationSeconds)) * 100)
            )
            if (percent >= 0) onProgress(percent)
          }
        }
      })

      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail}`))
      })
    })

    return { downloads: await this.measureDownloads(id) }
  }

  /**
   * Stats the three `.aac` renditions on disk and reports their byte sizes
   * (ADR-0009). Split from `encode` so a retry that finds the HLS already staged
   * (the checkpoint in ProcessTranscode) can still recover the sizes without
   * re-encoding — the `.aac` were written in the same pass and are still there.
   */
  async measureDownloads(id: string): Promise<DownloadRendition[]> {
    return Promise.all(
      RENDITIONS.map(async (rendition) => {
        const { size } = await stat(downloadRenditionPath(id, rendition.name))
        return { name: rendition.name, bitrate: rendition.bitrate, bytes: size }
      })
    )
  }

  /**
   * **L'archive FLAC, dans sa propre passe** — appelée par le job d'archivage,
   * après `COMPLETED` (ADR-0004).
   *
   * Un seul flux de sortie, sans progression : personne n'attend ce fichier, et
   * lui câbler un pourcentage donnerait un second compteur qui ne s'affiche
   * nulle part. Voir l'en-tête de la classe pour ce que ce découpage coûte (un
   * second décodage) et ce qu'il rachète (l'écoute cesse d'attendre la
   * conservation).
   *
   * **Jamais pour une source distante** : l'original vit à son URL, il n'y a
   * rien à archiver — l'appelant le sait et ne l'appelle pas.
   */
  async encodeArchive(source: string, id: string): Promise<void> {
    const target = archivePath(id)
    await mkdir(dirname(target), { recursive: true })

    const args = [
      '-hide_banner',
      '-y',
      '-i',
      source,
      '-vn',
      '-nostats',
      '-map',
      '0:a:0',
      '-c:a',
      'flac',
      target,
    ]

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', args)

      let stderrTail = ''
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })

      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg (archive) exited with code ${code}: ${stderrTail}`))
      })
    })
  }

  private buildArgs(source: string, id: string, outDir: string): string[] {
    const bitrateFlags = RENDITIONS.flatMap((rendition, index) => [
      `-b:a:${index}`,
      rendition.bitrate,
    ])
    const streamMap = RENDITIONS.map(
      (rendition, index) => `a:${index},name:${rendition.name}`
    ).join(' ')

    return [
      '-hide_banner',
      '-y',
      '-i',
      source,
      '-vn',
      '-progress',
      'pipe:1',
      '-nostats',
      // Output 1 — the three HLS renditions + master playlist.
      ...RENDITIONS.flatMap(() => ['-map', '0:a:0']),
      '-c:a',
      'aac',
      ...bitrateFlags,
      '-f',
      'hls',
      '-hls_time',
      String(HLS_SEGMENT_SECONDS),
      '-hls_playlist_type',
      'vod',
      '-hls_flags',
      'independent_segments',
      '-master_pl_name',
      'master.m3u8',
      '-var_stream_map',
      streamMap,
      '-hls_segment_filename',
      join(outDir, '%v', 'seg_%03d.ts'),
      join(outDir, '%v', 'index.m3u8'),
      // Outputs 2-4 — the three progressive `.aac` download renditions, mapped
      // from the same source read (no second decode). Produced on both ingestion
      // paths: they are a serving artefact, not an archive (ADR-0009).
      ...downloadOutputArgs(id),
    ]
  }
}
