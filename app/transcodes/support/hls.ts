import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { join } from 'node:path'
import type { MediaTags } from '#transcodes/support/media_tags'

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

/* -------------------------------------------------------------------------- */
/*  Profil « radio » — une sortie unique, normalisée en niveau (issue #46)     */
/* -------------------------------------------------------------------------- */

/**
 * Le conteneur, le codec et le **débit unique** de la sortie radio.
 *
 * ## Pourquoi 128 kbps, et pas le plancher de 64
 *
 * Ce fichier **n'est pas écouté par un auditeur** : liquidsoap le lit depuis le
 * RustFS de la même machine, le mélange aux autres, et **ré-encode** le flux
 * qu'il diffuse. C'est donc un *master de diffusion*, et la connectivité
 * contrainte de la zone couverte s'applique au flux sortant de liquidsoap, pas à
 * ce fichier-ci. Le calibrer sur le débit de l'antenne ferait payer deux fois la
 * perte : une fois ici, une fois à la diffusion.
 *
 * 64 kbps est le plancher de l'échelle HLS (ADR-0001) et il a été choisi pour de
 * la **louange diffusée telle quelle** ; commencer une chaîne de deux encodages
 * lossy au plancher, c'est s'assurer que le second passe sous. 128 kbps — le
 * barreau `mid`, déjà en production — laisse cette marge, et le coût de stockage
 * reste modeste : ~0,96 Mo par minute, soit ~2,9 Mo pour un titre de trois
 * minutes, ~1,5 Go pour une discothèque de cinq cents titres.
 *
 * ## Pourquoi MP4/M4A, et non l'ADTS des téléchargements
 *
 * L'ADR-0009 choisit l'ADTS pour une raison précise : le client mobile doit
 * pouvoir jouer un fichier **à moitié téléchargé**, donc aucun index central. Ici
 * personne ne lit un fichier partiel — liquidsoap ne l'ouvre qu'après
 * `COMPLETED`. En revanche l'antenne a besoin de la **durée à la seconde** pour
 * calculer ses fondus et ses coupures, et un ADTS n'en porte aucune : elle y est
 * *estimée* depuis la taille (≈1 % de dérive, ADR-0009). Le `moov` d'un MP4 la
 * porte exactement, et elle s'accorde alors au chiffre publié dans le webhook —
 * deux sources qui se contredisent de 1 % coûteraient plus cher que l'index.
 */
export const RADIO_FORMAT = {
  /** Muxeur ffmpeg (`-f`). `+movflags faststart` met le `moov` en tête. */
  container: 'mp4',
  /** Codec ffmpeg (`-c:a`). */
  codec: 'aac',
  /** Extension portée sur le disque et dans la clé publique. */
  extension: 'm4a',
  /** Content-type posé à l'envoi et servi par l'origine. */
  contentType: 'audio/mp4',
  /** Le débit **unique** — voir l'en-tête pour le raisonnement. */
  bitrate: '128k',
  /**
   * ⚠️ **La fréquence d'échantillonnage est forcée, et ce n'est pas cosmétique.**
   *
   * Le filtre `loudnorm` travaille en interne à **192 kHz** et c'est aussi la
   * fréquence de sa sortie : sans `-ar`, l'encodeur AAC reçoit du 192 kHz et
   * écrit ce qu'il peut en porter — **96 kHz**, son plafond, mesuré sur
   * ffmpeg 9.0.1 depuis une source en 48 kHz. Donc une sortie à une fréquence
   * que personne n'a demandée, deux fois celle de la source, pour un contenu
   * qui ne porte rien au-dessus.
   *
   * **Ce n'est pas le poids qui pose problème** : `-b:a` est honoré et le
   * fichier ne grossit que de ~2 % (50 464 contre 49 345 octets sur trois
   * secondes de bruit rose). C'est la fréquence elle-même — liquidsoap et les
   * lecteurs mobiles n'attendent pas du 96 kHz, et le ré-échantillonnage est
   * payé à chaque lecture. Et la panne ne ressemble pas à une panne : le
   * fichier joue.
   */
  sampleRate: 48_000,
} as const

/**
 * La cible de normalisation, en unités EBU R128.
 *
 * `-16 LUFS` est la convention des plateformes de diffusion en ligne (AES
 * TD1004) plutôt que le `-23 LUFS` de la radio FM : l'antenne est écoutée au
 * téléphone, souvent dans le bruit, et un fonds calé à -23 obligerait chaque
 * auditeur à monter le volume — exactement le geste qu'on cherche à supprimer.
 *
 * `TP = -1,5 dBTP` laisse de la marge au ré-encodage de liquidsoap : un lossy
 * qui part d'un pic à -0,1 fabrique des pics inter-échantillons au-dessus de 0.
 *
 * La valeur absolue compte d'ailleurs moins que le fait qu'elle soit **la même
 * pour tous** : c'est l'écart entre deux titres qui s'entend, pas le niveau.
 */
export const RADIO_LOUDNESS = {
  /** Loudness intégrée visée (LUFS). */
  targetI: -16,
  /** Pic vrai maximal (dBTP). */
  targetTp: -1.5,
  /** Plage de loudness visée (LU) — valeur usuelle pour de la musique. */
  targetLra: 11,
} as const

/**
 * Ce que la **passe d'analyse** de `loudnorm` a mesuré sur la source. Ces cinq
 * nombres sont les entrées de la passe d'application : c'est tout l'objet du
 * double décodage.
 */
export interface LoudnessMeasurement {
  /** Loudness intégrée mesurée (LUFS). */
  i: number
  /** Pic vrai mesuré (dBTP). */
  tp: number
  /** Plage de loudness mesurée (LU). */
  lra: number
  /** Seuil de porte mesuré (LUFS). */
  thresh: number
  /** Correction que `loudnorm` demande de lui repasser (LU). */
  targetOffset: number
}

/**
 * **Le niveau, mesuré et publié** — ce que l'antenne relit pour vérifier qu'un
 * titre est bien au niveau des autres.
 *
 * Les champs `output*` ne sont pas une prédiction : `loudnorm` les calcule sur
 * le résultat, pendant la passe qui l'écrit. Personne ne redécode pour les
 * obtenir.
 *
 * `type` et non `interface` : voir {@link RadioTrackInfo}, qui l'imbrique.
 */
export type RadioLoudness = {
  /** La cible visée (LUFS) — `RADIO_LOUDNESS.targetI` au moment de l'encodage. */
  targetI: number
  /** Loudness intégrée de la **source** (LUFS). */
  inputI: number
  /** Pic vrai de la source (dBTP). */
  inputTp: number
  /** Plage de loudness de la source (LU). */
  inputLra: number
  /** Loudness intégrée **du fichier produit** (LUFS) — le chiffre qui compte. */
  outputI: number
  /** Pic vrai du fichier produit (dBTP). */
  outputTp: number
  /** Plage de loudness du fichier produit (LU). */
  outputLra: number
  /**
   * `linear` ou `dynamic`, tel que `loudnorm` l'annonce.
   *
   * `linear` = un gain constant, les dynamiques du titre sont intactes ; c'est
   * le cas normal et le but du double décodage. `dynamic` signale que le gain
   * demandé aurait fait dépasser le pic cible et que le filtre a compressé —
   * le titre sort au bon niveau mais il a été retouché, et c'est la seule chose
   * que ce champ existe pour dire.
   */
  normalization: string
}

/**
 * La piste radio telle qu'elle est **persistée** sur la ligne et **publiée**
 * dans le webhook de complétion : l'URL unique, la taille mesurée localement,
 * le niveau mesuré, et les étiquettes lues sur la source.
 *
 * Un seul objet, comme `downloads` : ce qui est toujours écrit et lu ensemble
 * n'a pas besoin de quatre colonnes, et la forme épouse la charge utile du
 * webhook au champ près.
 *
 * ⚠️ **`type` et non `interface`, pour tout ce bloc et ses imbriqués.** Cet objet
 * part dans `TranscodeWirePayload`, que Transmit exige assignable à son
 * `Broadcastable` — donc indexable par `string`. TypeScript n'accorde cette
 * signature d'index implicite qu'aux **alias** : il ne suffit pas que le payload
 * en soit un, chaque type de valeur qu'il porte doit l'être aussi. Une
 * `interface` ici — ou sur {@link RadioLoudness}, ou sur `MediaTags` — casse
 * `npm run typecheck` dans `TranscodePublisher`, et le message accuse le payload
 * plutôt que le champ fautif.
 */
export type RadioTrackInfo = {
  /** L'URL absolue, non signée et permanente sur l'origine publique. */
  url: string
  /** La taille du fichier en octets, mesurée localement (aucun `HEAD`). */
  bytes: number
  /**
   * Le niveau mesuré — entrée et sortie —, ou `null` si `loudnorm` n'a rien
   * imprimé d'exploitable. Nul plutôt qu'approché : un chiffre de niveau qu'on
   * n'a pas mesuré se recopierait dans un tableau de bord et s'y défendrait.
   */
  loudness: RadioLoudness | null
  /** Les étiquettes de la source, quand elle en porte. */
  tags: MediaTags
}

/**
 * Le staging local de la sortie radio. **Hors** du dossier HLS et hors de celui
 * des téléchargements, pour la même raison qu'eux : chaque dossier est poussé en
 * entier sous son propre préfixe, et un fichier égaré dans le mauvais dossier
 * partirait avec le mauvais content-type et la mauvaise clé.
 */
export function radioOutputDir(id: string): string {
  return app.makePath('storage/radio', id)
}

/**
 * Le fichier radio sur le disque local — **sa présence marque « déjà encodé »**,
 * comme `master.m3u8` pour le HLS (point de reprise de l'ADR-0004).
 *
 * Nommé `track`, pas `<id>` : l'identifiant est déjà dans le dossier, et le
 * répéter ferait une clé `radio/<id>/<id>.m4a`.
 */
export function radioTrackPath(id: string): string {
  return join(radioOutputDir(id), `track.${RADIO_FORMAT.extension}`)
}

/**
 * Le préfixe RustFS de la sortie radio : `radio/<id>`. L'envoi **et** la reprise
 * en dérivent leurs clés (même discipline que `hlsKeyPrefix`), et l'`<id>` fait
 * de chaque ré-encodage une **nouvelle URL**.
 *
 * Un préfixe, pour un seul fichier, parce que la reprise passe par
 * `deletePrefix` : elle normalise le préfixe à exactement un `/` final et ne
 * peut donc pas déborder sur un voisin dont le nom commence pareil.
 */
export function radioKeyPrefix(id: string): string {
  return `radio/${id}`
}

/** La clé RustFS de la piste radio : `radio/<id>/track.m4a`. */
export function radioTrackKey(id: string): string {
  return `${radioKeyPrefix(id)}/track.${RADIO_FORMAT.extension}`
}

/**
 * L'URL publique absolue de la piste radio (ADR-0006), sur la même origine que
 * le HLS et les téléchargements.
 *
 * **Non signée et permanente**, pour la raison de l'ADR-0009 poussée plus loin
 * encore : une URL signée n'expirerait pas « pendant une pause » mais **en
 * pleine diffusion**, et l'antenne se tairait au milieu d'un titre.
 */
export function radioTrackUrl(id: string): string {
  const base = env.get('HLS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  return `${base}/${radioTrackKey(id)}`
}

/**
 * Le filtre `loudnorm`, avec ou sans mesure préalable.
 *
 * **Avec** [measured] (le cas normal) : le filtre applique un **gain constant**
 * calculé à partir de la mesure — `linear=true`. Les dynamiques du titre sont
 * intactes, seul son niveau bouge. C'est ce qu'une antenne veut : égaliser
 * *entre* les titres sans retoucher *dans* les titres.
 *
 * **Sans** : le filtre retombe sur sa normalisation **dynamique**, un gain qui
 * varie au fil du morceau. Le niveau moyen est juste, mais une intro calme se
 * retrouve poussée — un défaut audible sur de la musique. Ce mode n'est ici
 * qu'un filet : il ne sert que si l'analyse n'a rien rendu d'exploitable (une
 * source silencieuse rend `-inf`), et il valait mieux un titre normalisé
 * approximativement qu'un job en échec.
 *
 * `print_format=json` fait imprimer la mesure sur stderr **dans les deux modes**,
 * et dans le second elle porte aussi le niveau du fichier produit : c'est de là
 * que vient le « niveau mesuré » publié, sans le moindre décodage de plus.
 */
export function loudnormFilter(measured: LoudnessMeasurement | null): string {
  const parts = [
    `I=${RADIO_LOUDNESS.targetI}`,
    `TP=${RADIO_LOUDNESS.targetTp}`,
    `LRA=${RADIO_LOUDNESS.targetLra}`,
  ]

  if (measured) {
    parts.push(
      `measured_I=${measured.i}`,
      `measured_TP=${measured.tp}`,
      `measured_LRA=${measured.lra}`,
      `measured_thresh=${measured.thresh}`,
      `offset=${measured.targetOffset}`,
      'linear=true'
    )
  }

  parts.push('print_format=json')
  return `loudnorm=${parts.join(':')}`
}

/**
 * Les arguments complets de la **passe d'analyse** : décoder la source, la
 * traverser avec `loudnorm`, et n'écrire nulle part (`-f null -`).
 *
 * Aucun encodage ici — c'est tout l'intérêt : cette passe coûte un décodage,
 * la part bon marché du travail, et non un second encodage.
 */
export function radioAnalysisArgs(source: string): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i',
    source,
    '-vn',
    '-nostats',
    '-map',
    '0:a:0',
    '-af',
    loudnormFilter(null),
    '-f',
    'null',
    '-',
  ]
}

/**
 * Les arguments de sortie de la **passe d'application** : une seule sortie, au
 * débit unique, normalisée avec la mesure de la passe d'analyse.
 *
 * ⚠️ `-ar` est obligatoire : `loudnorm` sort en 192 kHz. Voir
 * `RADIO_FORMAT.sampleRate`.
 */
export function radioOutputArgs(id: string, measured: LoudnessMeasurement | null): string[] {
  return [
    '-map',
    '0:a:0',
    '-af',
    loudnormFilter(measured),
    '-ar',
    String(RADIO_FORMAT.sampleRate),
    '-c:a',
    RADIO_FORMAT.codec,
    '-b:a',
    RADIO_FORMAT.bitrate,
    '-movflags',
    '+faststart',
    '-f',
    RADIO_FORMAT.container,
    radioTrackPath(id),
  ]
}
