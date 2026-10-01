import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { join } from 'node:path'
import type { MediaTags } from '#transcodes/support/media_tags'
import type { TranscodeProfile } from '#transcodes/support/transcode_enums'

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

/**
 * **La durée de segment est une propriété du profil**, et non une constante posée
 * à côté de lui.
 *
 * Elle l'a été : une seule valeur, `6`, lue par la passe des enseignements. Le
 * profil `sparks` demande 5 s et le profil `radio` ne segmente rien du tout —
 * trois réponses différentes à la même question, qui ne peuvent plus tenir dans
 * une constante. La ranger ici referme le compilateur sur le sujet : un profil
 * nouveau ne compile pas tant qu'on n'a pas dit ce qu'il fait de ses segments.
 *
 * `null` pour `radio` et ce n'est pas un oubli : sa sortie est **un fichier**, pas
 * une playlist. Un `0` ou un `6` inutilisé aurait laissé croire le contraire au
 * prochain lecteur.
 *
 * ## Pourquoi 6 s pour un enseignement et 5 s pour un Spark
 *
 * Un segment est le grain du **démarrage** : le lecteur doit en avoir au moins un
 * avant de produire un son. Un sermon d'une heure est choisi puis écouté jusqu'au
 * bout — une seconde de plus au démarrage ne se paie qu'une fois, et des segments
 * longs font moins de fichiers à pousser (3223 pour 1 h 47, voir le README). Un
 * Spark dure trente secondes, s'enchaîne par un tap, et son démarrage **est**
 * l'essentiel de son expérience.
 *
 * ⚠️ Pour que ce grain existe vraiment, il faut que chaque segment soit
 * **décodable seul**, donc qu'une image-clé tombe sur sa frontière. Voir
 * {@link sparksOutputArgs} : sans cela, mesuré au banc, x264 coupe à 8,33 s et le
 * réglage de 5 s n'a servi à rien.
 */
export const PROFILE_SEGMENT_SECONDS = {
  teaching: 6,
  radio: null,
  sparks: 5,
} as const satisfies Record<TranscodeProfile, number | null>

/** La durée de segment d'un profil, ou `null` s'il ne segmente pas. */
export function segmentSeconds(profile: TranscodeProfile): number | null {
  return PROFILE_SEGMENT_SECONDS[profile]
}

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
   * écrit ce qu'il peut en porter — **96 kHz**, son plafond. Donc une sortie à une
   * fréquence que personne n'a demandée, deux fois celle de la source, pour un
   * contenu qui ne porte rien au-dessus.
   *
   * Vérifié sur les **deux** versions qui comptent : ffmpeg 9.0.1 (poste de dev) et
   * 7.1.5 (l'image de production, Debian trixie). Les deux montent à 96 kHz sans
   * `-ar` et redescendent à 48 kHz avec.
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
export const LOUDNESS_TARGET = {
  /** Loudness intégrée visée (LUFS). */
  targetI: -16,
  /** Pic vrai maximal (dBTP). */
  targetTp: -1.5,
  /** Plage de loudness visée (LU) — valeur usuelle pour de la musique. */
  targetLra: 11,
} as const

/**
 * Le nom historique de {@link LOUDNESS_TARGET}, gardé parce que l'ADR-0010 et les
 * bancs le citent.
 *
 * **Une seule cible pour les deux profils**, et c'est voulu : l'intérêt d'un
 * niveau de référence est qu'il soit le même partout. Un Spark et un titre de
 * l'antenne s'enchaînent dans la même oreille, souvent dans la même minute.
 */
export const RADIO_LOUDNESS = LOUDNESS_TARGET

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
 *
 * Nommé d'après la **mesure**, et non d'après le profil qui l'a demandée : la
 * radio et les Sparks normalisent avec le même filtre, la même cible et les mêmes
 * deux passes, donc ils publient le même objet. Le profil `radio` continue de le
 * nommer {@link RadioLoudness}, qui n'est plus qu'un autre nom pour celui-ci.
 */
export type LoudnessReport = {
  /** La cible visée (LUFS) — `LOUDNESS_TARGET.targetI` au moment de l'encodage. */
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
   * `linear` = un gain constant : les dynamiques du titre sont intactes, seul son
   * niveau bouge. C'est le but du double décodage, et c'est mesuré — l'écart entre
   * un passage fort et un passage faible ressort **inchangé** (8,0 LU en entrée
   * comme en sortie), là où le mode dynamique le rabote de 2,3 LU.
   *
   * `dynamic` = le filtre a fait varier son gain, donc **il a retouché l'intérieur
   * du titre**. Le niveau moyen est juste, mais une intro calme a été poussée.
   *
   * ⚠️ **Ce champ n'est pas un ornement, et `dynamic` n'est pas un cas rare.**
   * `loudnorm` refuse le mode linéaire dès qu'une des deux conditions manque :
   * `measured_LRA` > `LRA` cible (un gain constant ne réduit pas une plage), ou
   * `measured_TP + gain` > `TP` cible. La seconde se réduit à `TP − I ≤ 14,5 LU`,
   * une propriété de la source et non de son niveau — et du bruit rose nu est
   * déjà à la limite. Un master écrêté passe, un enregistrement capté en direct
   * et non traité, souvent pas.
   *
   * C'est donc le **seul** endroit où l'on apprend qu'un titre donné a été
   * comprimé, et la proportion de `dynamic` sur l'ensemble des pistes est ce qui
   * dira s'il faut un limiteur en amont (ADR-0010).
   */
  normalization: string
}

/**
 * Le nom sous lequel le profil `radio` publie son niveau — **un alias**, pas une
 * seconde forme.
 *
 * Il est gardé parce que l'ADR-0010 et le README le citent, et parce que renommer
 * un type n'a jamais rien appris à personne. Un alias d'alias reste un alias :
 * Transmit l'accepte toujours (voir {@link RadioTrackInfo} pour ce que coûterait
 * une `interface` ici).
 */
export type RadioLoudness = LoudnessReport

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
   * La durée exacte du média, ou `null` si la sonde n'a rien rendu d'exploitable.
   *
   * ⚠️ **Elle voyage ICI, et pas seulement au premier niveau du webhook**, pour
   * la même raison qu'un enseignement porte la sienne dans `download.duration` :
   * **le sondage de statut est le chemin de rattrapage d'un webhook perdu**. Une
   * durée qui n'existerait que dans le webhook serait définitivement perdue si
   * celui-ci n'arrive pas — la réécriture idempotente du portail ne la republie
   * pas —, et l'antenne ne peut pas programmer un morceau dont elle ignore la
   * durée. Le premier niveau du webhook la garde par symétrie avec l'existant ;
   * c'est cette copie-ci qui rend le rattrapage complet.
   */
  durationSeconds: number | null
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
    `I=${LOUDNESS_TARGET.targetI}`,
    `TP=${LOUDNESS_TARGET.targetTp}`,
    `LRA=${LOUDNESS_TARGET.targetLra}`,
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

/* -------------------------------------------------------------------------- */
/*  Profil « sparks » — deux rendus, segments de 5 s, et la vidéo s'ouvre (#49) */
/* -------------------------------------------------------------------------- */

/**
 * Un rendu du profil `sparks` : une largeur maximale, un débit vidéo et un débit
 * audio.
 *
 * ## Deux rendus, et non un — ce sont deux molettes distinctes
 *
 * La durée de segment fixe le **démarrage** ; le nombre de rendus protège les
 * **réseaux faibles**. Confondre les deux conduit à croire qu'un seul débit
 * suffit « puisque les segments sont courts », alors qu'un segment court sur un
 * débit trop haut se télécharge simplement plus lentement qu'il ne se joue. Le
 * parc va de la 4G du siège à l'EDGE d'une branche mal desservie : un seul débit,
 * c'est choisir d'avance qui sera mal servi.
 *
 * ## Pourquoi une largeur, et pas une hauteur
 *
 * Un Spark est filmé au téléphone, donc **vertical** la plupart du temps, et il
 * est regardé plein écran sur un téléphone. Brider la hauteur (`scale=-2:720`)
 * ramènerait une vidéo verticale 1080×1920 à 405×720 — illisible — tandis que la
 * même règle sur une horizontale donnerait 1280×720, deux fois plus de pixels. La
 * largeur est le côté qui touche les bords de l'écran dans les deux orientations :
 * c'est elle qui décide de ce que l'œil voit.
 *
 * Et jamais d'agrandissement : `min(<largeur>, iw)` laisse passer telle quelle une
 * source déjà plus petite. Agrandir ne rajoute aucun détail, seulement des octets.
 */
export interface SparksRendition {
  /** Le barreau, et le nom du dossier dans le jeu HLS. */
  name: string
  /** Largeur maximale en pixels ; la hauteur suit le rapport d'origine. */
  width: number
  /** Débit vidéo visé. */
  videoBitrate: string
  /** Plafond instantané — 110 % du visé, de quoi absorber une scène chargée. */
  videoMaxrate: string
  /** Taille du tampon du régulateur de débit. */
  videoBufsize: string
  /** Débit audio de ce barreau, quand la source porte une image. */
  audioBitrate: string
}

/**
 * L'échelle à **deux** barreaux, du plus pauvre au plus riche (l'ordre des
 * dossiers et du `master.m3u8`).
 *
 * `low` tient dans ~464 kbps au total : c'est ce qu'un réseau de branche peut
 * soutenir. `high` à ~1,3 Mbps est le confort d'une 4G urbaine. Entre les deux il
 * n'y a rien, et c'est assumé — un troisième barreau coûterait un encodage de
 * plus sur le chemin critique d'un média qui bloque la publication de son
 * annonce, pour une granularité que l'ABR ne saurait pas exploiter sur trente
 * secondes.
 */
export const SPARKS_RENDITIONS: readonly SparksRendition[] = [
  {
    name: 'low',
    width: 480,
    videoBitrate: '400k',
    videoMaxrate: '440k',
    videoBufsize: '800k',
    audioBitrate: '64k',
  },
  {
    name: 'high',
    width: 720,
    videoBitrate: '1200k',
    videoMaxrate: '1320k',
    videoBufsize: '2400k',
    audioBitrate: '96k',
  },
]

/**
 * L'échelle quand le Spark est **purement sonore**.
 *
 * Un Spark porte « au plus un média temporel, audio **ou** vidéo » : les deux cas
 * existent, et un dépôt audio n'a pas de piste à encoder. Les deux barreaux
 * reprennent alors `low`/`mid` de l'échelle historique (ADR-0001) — 64 kbps est le
 * plancher de la parole et de la louange, 128 le confort. Les débits audio de
 * l'échelle vidéo (64/96) n'auraient pas de sens ici : sans vidéo à financer, il
 * n'y a aucune raison de rogner sur le son du barreau haut.
 */
export const SPARKS_AUDIO_RENDITIONS: readonly Rendition[] = [
  { name: 'low', bitrate: '64k' },
  { name: 'high', bitrate: '128k' },
]

/**
 * Le codec vidéo et ses réglages de compatibilité.
 *
 * `libx264` + `yuv420p` + profil `main` : le seul triplet qu'un parc Android
 * d'entrée de gamme décode **en matériel**. Un profil `high` ou un `yuv444p`
 * joueraient sur le poste de développement et se décoderaient en logiciel sur le
 * téléphone de l'auditeur, c'est-à-dire mal et en vidant sa batterie.
 *
 * `veryfast` parce que ce travail est **sur le chemin critique de la
 * publication** : un Spark qui annonce un média ne paraît qu'avec son média, et la
 * notification part à ce moment-là. Un Spark dure trente secondes — la différence
 * de qualité entre `veryfast` et `medium` à ces débits ne se voit pas sur un
 * téléphone, le délai, si.
 */
export const SPARKS_VIDEO = {
  codec: 'libx264',
  preset: 'veryfast',
  profile: 'main',
  pixelFormat: 'yuv420p',
} as const

/**
 * La vignette extraite de la vidéo, et le format sous lequel elle est servie.
 *
 * Le document de rendu du mobile exige **un poster sur tout statut vidéo**.
 * Quand l'auteur n'a pas déposé d'image, l'extraction est la seule façon de ne
 * jamais laisser l'écran sur un carré noir pendant que le premier segment arrive.
 */
export const POSTER_FORMAT = {
  /** Muxeur ffmpeg (`-f`) — une image et une seule, sans motif `%d`. */
  container: 'mjpeg',
  /** Extension sur le disque et dans la clé publique. */
  extension: 'jpg',
  /** Content-type posé à l'envoi. */
  contentType: 'image/jpeg',
  /** Largeur maximale, alignée sur le barreau haut : c'est le même écran. */
  width: 720,
  /** Qualité JPEG (`-q:v`, 2 = meilleure, 31 = pire). */
  quality: 3,
} as const

/**
 * La fréquence d'échantillonnage à laquelle la forme d'onde est relevée, en Hz.
 *
 * Mille, parce que c'est à la fois **assez** et **rien** : trente-six barres sur
 * un Spark de 30 s font 833 échantillons par barre, largement de quoi un efficace
 * stable, et le tuyau ne charrie que 2 Ko par seconde de média — 60 Ko pour un
 * Spark, lus en mémoire sans y penser. Le ré-échantillonnage fait au passage
 * l'enveloppe qu'on cherche à dessiner.
 */
export const WAVEFORM_SAMPLE_RATE = 1000

/**
 * **Ce qu'un Spark publie**, et donc ce que le portail relit — par les trois
 * canaux, comme toute valeur publiée (ADR-0006).
 *
 * `playlist` redit `outputPlaylist` **exprès** : un consommateur qui lit
 * `sparkMedia` n'a pas à savoir qu'un autre champ, en dehors de l'objet, porte la
 * moitié de la réponse. C'est le même raisonnement qui a mis `durationSeconds`
 * dans `radioTrack` alors que le webhook la portait déjà.
 *
 * ⚠️ **`type` et non `interface`, et récursivement** — `LoudnessReport`,
 * `MediaTags` et celui-ci. Cet objet part dans `TranscodeWirePayload`, que
 * Transmit exige assignable à son `Broadcastable`, donc indexable par `string` :
 * TypeScript n'accorde cette signature d'index implicite qu'aux **alias**. Une
 * `interface` ici casse `npm run typecheck` dans `TranscodePublisher`, et le
 * message accuse le payload, à deux fichiers du champ fautif.
 */
export type SparkMedia = {
  /** L'URL absolue du `master.m3u8` — la même que `outputPlaylist`. */
  playlist: string
  /**
   * La vignette extraite de la vidéo, ou `null` quand le Spark est purement
   * sonore. `null` et non absent : le client doit pouvoir distinguer « pas de
   * poster parce qu'il n'y a pas d'image » de « champ pas encore servi ».
   */
  poster: string | null
  /** `true` quand une piste vidéo a été encodée (et non seulement reçue). */
  hasVideo: boolean
  /** La durée exacte du média, ou `null` si la sonde n'a rien rendu. */
  durationSeconds: number | null
  /**
   * Trente-six hauteurs entières de 0 à 100, ou `null` si la passe d'analyse n'a
   * pas rendu assez d'échantillons. Voir `waveform.ts` pour l'échelle, et pour
   * ce que le repli par hachage du client a de faux.
   */
  waveform: number[] | null
  /**
   * Le niveau mesuré — entrée et sortie —, ou `null` si `loudnorm` n'a rien
   * imprimé d'exploitable.
   *
   * ⚠️ **Lire `normalization` avant de croire que le média n'a pas été retouché.**
   * `loudnorm` refuse le gain constant dès que `TP − I ≤ 14,5 LU`, et c'est une
   * propriété de la source : un Spark enregistré au téléphone, non traité, tombe
   * souvent du mauvais côté. La proportion de `dynamic` est le chiffre à
   * surveiller en production (ADR-0010, ADR-0011).
   */
  loudness: LoudnessReport | null
  /** Les étiquettes de la source, quand elle en porte. */
  tags: MediaTags
}

/**
 * La vignette sur le disque local — **dans le dossier HLS**, donc poussée avec lui
 * sous le même préfixe et effacée par la même reprise.
 *
 * C'est la différence avec la piste radio, qui avait besoin de son propre dossier :
 * elle n'était pas un jeu HLS. Celle-ci en fait partie — elle est servie par le
 * même bloc Caddy, lue par la même politique de préfixe, et un `DELETE` qui efface
 * le jeu l'emporte sans qu'on ait eu à l'écrire nulle part.
 */
export function sparksPosterPath(id: string): string {
  return join(hlsOutputDir(id), `poster.${POSTER_FORMAT.extension}`)
}

/** La clé RustFS de la vignette : `hls/<id>/poster.jpg`. */
export function sparksPosterKey(id: string): string {
  return `${hlsKeyPrefix(id)}/poster.${POSTER_FORMAT.extension}`
}

/** L'URL publique absolue de la vignette (ADR-0006), sur l'origine du HLS. */
export function sparksPosterUrl(id: string): string {
  const base = env.get('HLS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  return `${base}/${sparksPosterKey(id)}`
}

/**
 * **La passe d'analyse d'un Spark : une lecture, deux sous-produits.**
 *
 * `loudnorm` doit traverser tout le fichier pour mesurer son niveau — c'est le
 * prix de la deuxième passe, déjà payé par la radio. Les échantillons sont donc
 * sous la main une fois et une seule, et la forme d'onde se prélève au passage :
 * le graphe dédouble l'audio (`asplit`), envoie une branche au filtre de mesure et
 * l'autre vers du PCM mono réduit à {@link WAVEFORM_SAMPLE_RATE} Hz, écrit sur
 * `pipe:1`.
 *
 * Aucun encodage ici non plus : la branche de mesure se jette dans `-f null -`.
 * Le second flux est du PCM brut, c'est-à-dire un memcpy.
 *
 * La **durée** et les **étiquettes** ne sont pas dans ce graphe : elles se lisent
 * dans l'en-tête du conteneur par `probe()`, sans décoder un seul échantillon. Les
 * faire sortir d'ici aurait été les payer plus cher qu'elles ne coûtent.
 */
export function sparksAnalysisArgs(source: string): string[] {
  const measure = loudnormFilter(null)
  return [
    '-hide_banner',
    '-y',
    '-i',
    source,
    '-nostats',
    '-filter_complex',
    `[0:a:0]asplit=2[measure][wave];[measure]${measure}[lnorm];` +
      `[wave]aformat=sample_fmts=s16:channel_layouts=mono,aresample=${WAVEFORM_SAMPLE_RATE}[pcm]`,
    '-map',
    '[lnorm]',
    '-f',
    'null',
    '-',
    '-map',
    '[pcm]',
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ]
}

/**
 * Le graphe de filtres de la passe d'application, selon que la source porte une
 * image ou non.
 *
 * L'audio est normalisé **une fois** puis dédoublé (`asplit`), et non normalisé
 * une fois par barreau : `loudnorm` avec la même mesure donnerait deux fois le
 * même résultat pour deux fois le travail.
 *
 * ⚠️ `aresample` n'est pas cosmétique : `loudnorm` travaille et sort en **192 kHz**,
 * et l'encodeur AAC écrirait alors du 96 kHz — son plafond —, c'est-à-dire une
 * fréquence que personne n'a demandée, pour un contenu qui ne porte rien
 * au-dessus. La panne ne ressemble pas à une panne : le fichier joue. C'est le
 * `-ar` du profil radio, exprimé dans le graphe parce qu'il y a ici deux sorties.
 */
function sparksFilterGraph(measured: LoudnessMeasurement | null, hasVideo: boolean): string {
  const ladder = hasVideo ? SPARKS_RENDITIONS : SPARKS_AUDIO_RENDITIONS

  const audio =
    `[0:a:0]${loudnormFilter(measured)},aresample=${RADIO_FORMAT.sampleRate},` +
    `asplit=${ladder.length}` +
    ladder.map((rendition) => `[a_${rendition.name}]`).join('')

  if (!hasVideo) return audio

  const split =
    `[0:v:0]split=${SPARKS_RENDITIONS.length}` +
    SPARKS_RENDITIONS.map((rendition) => `[v_${rendition.name}_in]`).join('')
  const scales = SPARKS_RENDITIONS.map(
    (rendition) => `[v_${rendition.name}_in]${scaleToWidth(rendition.width)}[v_${rendition.name}]`
  ).join(';')

  return `${split};${scales};${audio}`
}

/**
 * Le filtre d'échelle qui **borne la largeur sans jamais agrandir**.
 *
 * `min(<largeur>, iw)` laisse passer telle quelle une source déjà plus petite —
 * agrandir n'ajoute aucun détail, seulement des octets. `trunc(…/2)*2` et `h=-2`
 * gardent les deux côtés pairs, ce dont `yuv420p` a besoin : une hauteur impaire
 * fait échouer l'encodage, et une largeur impaire aussi.
 *
 * Les apostrophes sont **dans la chaîne passée à ffmpeg**, pas une politesse de
 * shell : elles protègent les virgules de l'expression, que le parseur de filtres
 * prendrait sinon pour des séparateurs de filtres.
 */
function scaleToWidth(width: number): string {
  return `scale=w='trunc(min(${width},iw)/2)*2':h=-2`
}

/**
 * **Les arguments de la passe d'application d'un Spark** : un jeu HLS à deux
 * rendus, segments de 5 s, images-clés sur les frontières, audio normalisé avec la
 * mesure de la passe d'analyse.
 *
 * ## ⚠️ Le piège central : `-hls_time` ne découpe pas, il *demande* à découper
 *
 * Le muxeur HLS ne coupe que sur une **image-clé**. Sans contrainte, x264 en pose
 * une tous les 250 images — soit 8,33 s à 30 i/s — et le muxeur, à qui l'on a
 * demandé 5 s, attend la suivante : **mesuré au banc, des segments de 8,33 s sur
 * un réglage de 5 s**. Le démarrage rapide qu'on paie en segments courts
 * n'existait pas, et rien ne le signalait : la playlist est valide, la vidéo joue.
 *
 * `-force_key_frames expr:gte(t,n_forced*<durée>)` place une image-clé exactement
 * à 0, 5, 10… secondes. L'expression est **indépendante de la cadence** de la
 * source — un `-g <images>` aurait fallu connaître les i/s, qu'un fichier filmé au
 * téléphone n'a aucune obligation de garder constantes.
 *
 * `independent_segments` l'écrit ensuite dans la playlist : le lecteur sait alors
 * qu'il peut commencer par n'importe quel segment.
 */
export function sparksOutputArgs(
  id: string,
  measured: LoudnessMeasurement | null,
  hasVideo: boolean
): string[] {
  const outDir = hlsOutputDir(id)
  const seconds = PROFILE_SEGMENT_SECONDS.sparks
  const ladder = hasVideo ? SPARKS_RENDITIONS : SPARKS_AUDIO_RENDITIONS

  const maps = ladder.flatMap((rendition) =>
    hasVideo
      ? ['-map', `[v_${rendition.name}]`, '-map', `[a_${rendition.name}]`]
      : ['-map', `[a_${rendition.name}]`]
  )

  const videoFlags = hasVideo
    ? [
        '-c:v',
        SPARKS_VIDEO.codec,
        '-preset',
        SPARKS_VIDEO.preset,
        '-profile:v',
        SPARKS_VIDEO.profile,
        '-pix_fmt',
        SPARKS_VIDEO.pixelFormat,
        ...SPARKS_RENDITIONS.flatMap((rendition, index) => [
          `-b:v:${index}`,
          rendition.videoBitrate,
          `-maxrate:v:${index}`,
          rendition.videoMaxrate,
          `-bufsize:v:${index}`,
          rendition.videoBufsize,
        ]),
        // L'image-clé sur la frontière de segment — voir l'en-tête.
        '-force_key_frames',
        `expr:gte(t,n_forced*${seconds})`,
      ]
    : []

  const audioFlags = hasVideo
    ? SPARKS_RENDITIONS.flatMap((rendition, index) => [`-b:a:${index}`, rendition.audioBitrate])
    : SPARKS_AUDIO_RENDITIONS.flatMap((rendition, index) => [`-b:a:${index}`, rendition.bitrate])

  const streamMap = ladder
    .map((rendition, index) =>
      hasVideo
        ? `v:${index},a:${index},name:${rendition.name}`
        : `a:${index},name:${rendition.name}`
    )
    .join(' ')

  return [
    '-filter_complex',
    sparksFilterGraph(measured, hasVideo),
    ...maps,
    ...videoFlags,
    '-c:a',
    'aac',
    ...audioFlags,
    '-f',
    'hls',
    '-hls_time',
    String(seconds),
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
  ]
}

/**
 * Les arguments d'extraction de la vignette : **une image**, redimensionnée au
 * barreau haut, en JPEG.
 *
 * `-ss` est placé **avant** `-i` — le décodeur saute au lieu de décoder puis de
 * jeter. Le point de prélèvement n'est pas 0 : une vidéo commence presque toujours
 * par du noir, un capuchon ou un doigt sur l'objectif, et un poster noir est
 * exactement ce que l'extraction existe pour éviter. L'appelant choisit l'instant
 * et sait retomber sur 0 si la source est plus courte que prévu.
 */
export function sparksPosterArgs(source: string, id: string, atSeconds: number): string[] {
  return [
    '-hide_banner',
    '-y',
    '-nostats',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    source,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-an',
    '-vf',
    scaleToWidth(POSTER_FORMAT.width),
    '-q:v',
    String(POSTER_FORMAT.quality),
    '-f',
    POSTER_FORMAT.container,
    sparksPosterPath(id),
  ]
}
