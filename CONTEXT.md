# Streaming Service

Module de diffusion de New Life : reçoit un fichier source (audio ou vidéo), l'encode
selon le **Profil** demandé et expose l'avancement en temps réel. C'est le « module de
diffusion externe » évoqué par l'ADR-0005 de `new-life-server` : les octets lourds
(segments, transcodage) vivent ici, pas dans le serveur applicatif.

**Audio par défaut, pas audio par nature.** Les profils `teaching` et `radio` jettent la
piste vidéo et n'encodent que le son ; le profil `sparks` l'encode (ADR-0011, amendement
de l'ADR-0001). C'est **le profil** qui dit ce qui est encodé, et la phrase « une vidéo est
un simple conteneur » n'est vraie que de deux profils sur trois.

## Language

**Transcode**:
Un job de transcodage : la conversion d'un fichier source unique en la sortie que son
**Profil** décrit, identifié par un UUID v7. Porte un cycle de vie (PENDING → PROCESSING →
COMPLETED/FAILED) et une progression. Sous `teaching` et `radio` la sortie ne contient
jamais de piste vidéo — une vidéo n'y est acceptée que comme conteneur dont on extrait
l'audio (`-vn`) ; sous `sparks` la piste vidéo est encodée. **Une source sans piste audio
reste un échec métier sur les trois profils.**
_Avoid_: Transcoding, Job, Conversion, Task

**Source**:
Le média d'origine d'un Transcode, fourni de deux façons : **téléversé** (`POST /upload`)
ou désigné par **URL** (`POST /transcodes`, ex. un objet S3). Téléversée, elle est écrite
sur le disque local, lue par le worker, puis supprimée à COMPLETED (une fois l'Archive
audio dans RustFS). Par URL, elle n'est **jamais copiée** localement : ffmpeg lit l'URL
directement, aucune Archive FLAC n'est produite, et l'URL (`source_url`) tient lieu de
master (ADR-0004).
_Avoid_: Original, Upload, Input file

**Archive audio**:
L'artefact durable et précieux d'un Transcode, poussé dans RustFS : aujourd'hui
**l'audio extrait sans perte (FLAC)** de la Source, jamais la vidéo. La stratégie
d'archivage est volontairement remplaçable — on pourrait un jour archiver la Source
d'origine intacte à la place. Distinct du HLS output (diffusion) : l'Archive est un
master de conservation/ré-encodage.
_Avoid_: Backup source, Master (seul)

**Cycle de vie du Transcode**:
`PENDING` (en file, source sur disque) → `PROCESSING` (ffmpeg en cours, 0→99 %) →
`COMPLETED` (master.m3u8 + segments prêts, servables par Caddy) **ou** `FAILED`.
Échec **permanent** (pas de piste audio, conteneur illisible) = FAILED direct, sans
retry. Échec **transitoire** (OOM, I/O, disque plein) = 3 tentatives backoff puis FAILED.
Sur COMPLETED **et** sur FAILED, la Source disque est supprimée (sur FAILED sans archivage).
La Reprise n'est **pas un état** : elle fait disparaître le Transcode depuis n'importe
lequel d'entre eux, y compris PENDING (job retiré de la file, ADR-0008).
_Avoid_: État, Statut (pour l'ensemble ; réserver `status` au champ)

**Reprise (delete)**:
La destruction, sur demande de l'appelant (`DELETE /transcodes/:id`), de **tout ce que
ce service a produit** pour un Transcode : préfixe HLS dans RustFS, Archive audio s'il
y en a une, staging local, progression Redis, ligne en base. Jamais la Source de
l'appelant — par URL, le master est **son** objet (ADR-0007), et l'absence d'archive
n'est pas une erreur. Un Transcode est reprenable **exactement quand aucun worker ne le
détient** : un job en attente est retiré de la file, un job actif répond `409` (ADR-0008).
Idempotente **sur l'effet** : deux reprises laissent le même état, la seconde répondant
`404`. Ce service n'a **aucune politique de rétention** : il exécute, l'appelant décide.
_Avoid_: Purge, Nettoyage, Cleanup, Annulation

**Rendu (rendition)**:
Une des variantes de débit d'un HLS output. L'échelle est **fixée par le Profil**, jamais
par la requête : `teaching` en a 3 (AAC-LC `low` 64, `mid` 128, `high` 192 kbps — 64 est le
plancher, en dessous la louange musicale se dégrade), `sparks` en a 2 (`low` et `high`,
vidéo comprise). Un `master.m3u8` les liste ; le lecteur choisit selon la bande passante
(ABR). **Le nombre de rendus et la durée de Segment sont deux réglages indépendants** : le
premier protège les réseaux faibles, le second fixe le démarrage.
_Avoid_: Variant, Quality (seul), Bitrate (seul), Qualité (elle décrit le contenu du
fichier, pas le régime qui l'a produit)

**Segment**:
Un morceau du HLS output, et le **grain du démarrage** : un lecteur ne produit rien avant
d'en avoir un entier. Sa durée est une **propriété du Profil** — 6 s sous `teaching`, 5 s
sous `sparks`, aucune sous `radio` qui ne segmente pas. Sur une sortie vidéo, un segment
n'est décodable seul que si une **image-clé** tombe sur sa frontière : sans cela le lecteur
remonte au segment précédent et le démarrage rapide disparaît (ADR-0011).
_Avoid_: Chunk, Tranche, Morceau

**HLS output**:
La playlist `master.m3u8`, les playlists de rendu et les Segments `.ts` produits
pour un Transcode — audio seul sous `teaching`, audio et vidéo sous `sparks`. **Servi depuis RustFS** via Caddy (RustFS est l'origine de diffusion,
pas seulement une archive). La copie locale n'est qu'un **staging transitoire** : elle est
supprimée une fois le HLS poussé dans RustFS, pour que le disque applicatif reste borné.
_Avoid_: Stream, Rendus, Playlist (seul)

**Profil (de sortie)**:
Ce que l'appelant demande qu'on **fabrique**, choisi au dépôt (`POST /transcodes`) et
immuable ensuite. `teaching` (le défaut, porté par la base) est le régime historique :
HLS output à 3 rendus, 3 Rendus progressifs, Archive audio sur le chemin par upload.
`radio` produit une seule **Piste radio** — ni HLS, ni rendus progressifs, ni archive ;
`outputPlaylist` y reste `null` à `COMPLETED`, et ce n'est pas une anomalie : c'est le
profil qui dit dans quel champ la sortie se lit.
`sparks` produit un HLS output **court** : 2 Rendus, Segments de 5 s, images-clés sur
leurs frontières, **piste vidéo encodée** quand la source en porte une, et la même
normalisation que `radio`. Sa sortie vit sous le préfixe `hls/` comme celle d'un
enseignement — `outputPlaylist` y est donc rempli — et le champ **Média de Spark** porte ce
qu'une playlist ne sait pas dire (ADR-0011).
Le profil décide de **ce qui est encodé et publié**, jamais du cycle de vie : mêmes
états, même progression, même point de reprise, même webhook, même Reprise (ADR-0010).
Il est aussi le seul à décider de la durée d'un Segment, de l'échelle de Rendus et du sort
de la piste vidéo.
_Avoid_: Mode, Type, Preset, Qualité, Régime (réservé au chemin d'ingestion dans les
journaux), « profil » tout court dans un propos adressé à un utilisateur

**Piste radio**:
La sortie unique du Profil `radio` : un fichier **AAC-LC 128 kbps, 48 kHz, normalisé en
niveau** (`loudnorm` en deux passes — mesurer, puis appliquer un gain constant), poussé
sous `radio/<id>/track.m4a` et servi depuis RustFS par une URL **non signée et
permanente**. Un master de diffusion, pas un flux d'écoute : liquidsoap le lit d'un bout
à l'autre et ré-encode ce qu'il diffuse. MP4 et non ADTS parce que l'antenne a besoin de
la **durée exacte** portée par le conteneur, pour ses fondus et ses coupures. Le niveau
homogène est l'objet de ce profil : sans lui, chaque enchaînement s'entend. Publiée sous
le champ `radioTrack` par les **trois canaux** (poll, SSE, webhook) et **seulement à
`COMPLETED`** : la ligne la porte plus tôt que les octets ne sont servables.
_Avoid_: Titre, Morceau, Rendu radio, Flux

**Média de Spark (`sparkMedia`)**:
Ce que le Profil `sparks` publie **en plus** de `outputPlaylist` : l'URL de la playlist
(redite, pour qu'un lecteur de ce champ n'ait pas à chercher ailleurs), la **Vignette**, le
drapeau `hasVideo`, la durée, la **Forme d'onde**, le niveau mesuré et les étiquettes de la
source. Servi par les **trois canaux** (poll, SSE, webhook) et **seulement à `COMPLETED`**,
comme la Piste radio — la ligne le porte plus tôt que les octets ne sont servables.
**Absent**, et non `null`, hors de ce profil.
_Avoid_: Annonce, Spark (seul — ce service ne connaît pas les annonces), Métadonnées

**Forme d'onde (waveform)**:
Trente-six hauteurs entières de 0 à 100, relevées **pendant la passe d'analyse** de
`loudnorm` — la seule lecture où les échantillons sont sous la main. Échelle en décibels
sous la barre la plus forte, plancher à -48 dB, efficace et non crête. Elle existe parce
que le repli du client (un hachage déterministe du texte) **dessine des collines sur un
silence**, et qu'une forme d'onde fausse est pire qu'une absence.
_Avoid_: Spectre, Enveloppe, Peaks

**Vignette (poster)**:
L'image extraite de la piste vidéo d'un Spark quand aucune n'a été déposée, prélevée au
quart de la durée (plafonnée à 3 s) pour éviter le noir du début. Elle vit **dans** le
dossier HLS (`hls/<id>/poster.jpg`), donc elle part et s'efface avec lui. `null` quand le
Spark est purement sonore, et `null` aussi quand l'extraction échoue : un Spark n'est pas
refusé pour une image manquante.
_Avoid_: Thumbnail, Miniature, Affiche (réservé à l'image déposée par l'auteur, côté portail)

**Canal temps réel (SSE)**:
Le flux Server-Sent-Events sur lequel un client suit un Transcode en direct, un canal
par ressource nommé `transcodes/<id>` (séparateur `/`, calé sur la route). On y pousse
**exactement la même charge utile** que le poll de statut (`id, status, progress,
outputPlaylist, error`, plus `radioTrack` sur le seul profil `radio`) : un seul
contrat. La diffusion passe par le transport Redis de Transmit, car le worker (qui
encode) et le serveur HTTP (auquel le client est connecté) sont deux processus
distincts. Canal **ouvert** pour l'instant ; l'auth arrive au jalon H.
_Avoid_: WebSocket, Socket, Topic, Room

**Webhook de complétion / Callback**:
La notification HTTP `POST` que le service pousse vers une URL fournie **par upload**
(`callbackUrl`) quand un Transcode atteint un état terminal (COMPLETED **ou** FAILED). Le
corps est le payload unifié (`{ id, status, progress, outputPlaylist, error }`), livré par
un job dédié avec retries ; signé en HMAC SHA-256 (`X-Transcode-Signature`) si un
`callbackSecret` est fourni (voir ADR-0005). Absent d'URL, le service reste en polling/SSE.
_Avoid_: Notification, Ping, Hook (seul)

**Vérification déléguée (auth)**:
Le service ne connaît **rien** de l'authentification : un middleware relaie le jeton
porteur reçu vers un endpoint HTTP configuré (`AUTH_VERIFY_URL`) et n'autorise la requête
que si la réponse correspond (statut attendu, et éventuellement un corps attendu). Un jeton
valide **suffit** — le service reste ignorant de l'identité de l'appelant (ADR-0003).
_Avoid_: Guard, Login, Session, Token verifier (seul)

**RustFS**:
Le magasin d'objets S3-compatible qui joue **deux rôles** : origine de diffusion du
HLS output, des Rendus progressifs et de la Piste radio (servis via Caddy) **et** dépôt
de l'Archive audio (FLAC). Ni la Source ni le
HLS ne s'accumulent sur le disque applicatif — tout ce qui est durable vit dans RustFS.
Rien n'y expire tout seul : ce qui y entre n'en sort que par une Reprise (ADR-0008).
_Avoid_: S3, Bucket, Storage (seul)
