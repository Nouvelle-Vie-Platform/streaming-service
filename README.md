# Streaming Service

Ingestion universelle (audio **ou** vidéo), encodage **HLS audio** et suivi en temps réel.

Le service reçoit un fichier source, en extrait l'audio, l'encode en trois qualités
HLS (AAC-LC) et expose l'avancement par **polling**, **SSE** et **webhook**. C'est le
module de diffusion audio de New Life : les octets lourds (segments, transcodage,
archive) vivent ici, servis depuis **RustFS**, jamais dans le serveur applicatif.

> **Audio uniquement.** Une vidéo est acceptée comme simple conteneur : sa piste vidéo
> est jetée (`-vn`), seule la bande-son est encodée (ADR-0001).

---

## Sommaire

- [Fonctionnement](#fonctionnement)
- [API](#api)
- [Cycle de vie & notifications](#cycle-de-vie--notifications)
- [Authentification](#authentification)
- [Prérequis](#prérequis)
- [Développement local](#développement-local)
- [Déploiement (Docker)](#déploiement-docker)
- [Servir le HLS avec Caddy](#servir-le-hls-avec-caddy)
- [Variables d'environnement](#variables-denvironnement)
- [Décisions & vocabulaire](#décisions--vocabulaire)

---

## Fonctionnement

```
[Client] --POST /upload (fichier + Bearer)-------------------> [Server]
   |                                          1. UUID v7, source sur disque local
   |                                          2. ligne PENDING (Postgres)
   |<-- 202 { id, status: PENDING, ... } ----- 3. job en file (Redis/BullMQ)
   |
   |     [Worker]  ffprobe -> 1 passe ffmpeg (3 rendus AAC + FLAC + master.m3u8)
   |               progress -> Redis (throttle 1%)   -> SSE + polling
   |               push HLS -> RustFS  => COMPLETED
   |               job d'archivage : FLAC -> RustFS, purge du disque local
   |
   |--GET /transcodes/:id/status (polling)-------------------> [Server]
   |==SSE  transcodes/:id  (temps réel)======================> [Transmit]
   |--webhook POST (à la finalisation, optionnel)-----------> [URL du client]
   '--DELETE /transcodes/:id --------------------------------> [Server]
                                              reprend HLS + archive + ligne + Redis
```

- **Postgres** : état durable d'un _Transcode_ (source de vérité du cycle de vie).
- **Redis** : back-end de la file BullMQ **et** progression volatile (le `%`).
- **RustFS** (S3) : **origine de diffusion** du HLS **et** dépôt de l'archive FLAC. Le
  disque applicatif reste borné (source et HLS supprimés après archivage). Rien n'est
  repris automatiquement : `DELETE /transcodes/:id` est le seul chemin de reprise, et
  c'est l'appelant qui décide quand (ADR-0008).

---

## API

Toutes les routes exigent un jeton `Authorization: Bearer <token>` (voir
[Authentification](#authentification)).

### `POST /upload`

`multipart/form-data` :

| Champ            | Requis | Description                                                                               |
| ---------------- | ------ | ----------------------------------------------------------------------------------------- |
| `file`           | ✅     | Source, ≤ 2 Go. Audio (`mp3 m4a aac flac ogg wav`) ou vidéo (`mp4 mkv mov webm avi wmv`). |
| `callbackUrl`    | —      | URL notifiée à la finalisation (webhook).                                                 |
| `callbackSecret` | —      | Secret HMAC pour signer le webhook.                                                       |

Réponse `202` :

```json
{
  "data": {
    "id": "0191…",
    "status": "PENDING",
    "progress": 0,
    "outputPlaylist": null,
    "error": null
  }
}
```

`422` si le fichier est invalide (extension/taille). La validation média réelle (présence
d'une piste audio) est **asynchrone** : un fichier sans audio est accepté puis passe `FAILED`.

### `POST /transcodes`

Ingestion par **URL** — le seul chemin que la plateforme emprunte : le portail range le
média dans RustFS puis nous remet une URL présignée. `application/json` :

| Champ            | Requis | Description                                                               |
| ---------------- | ------ | ------------------------------------------------------------------------- |
| `sourceUrl`      | ✅     | URL complète et lisible **pendant tout l'encodage** (ADR-0007).           |
| `profile`        | —      | `teaching` (défaut) ou `radio` — voir ci-dessous.                         |
| `callbackUrl`    | —      | URL notifiée à la finalisation (webhook).                                 |
| `callbackSecret` | —      | Secret HMAC pour signer le webhook.                                       |

Même réponse `202` que l'upload, même cycle de vie, mêmes notifications. Aucune copie
locale durable, aucune archive FLAC : le master reste l'objet de l'appelant (ADR-0007).

#### Le profil `radio` (ADR-0010)

Un morceau de musique n'a pas les besoins d'un sermon. Ce profil produit **une seule
sortie** — un AAC-LC **128 kbps, 48 kHz, normalisé en niveau** (`loudnorm` en deux
passes) — et rien d'autre :

```text
radio/<id>/track.m4a      ← la piste, non signée et permanente
```

Ni jeu HLS (segmenter une chanson de trois minutes n'apporte rien), ni rendus
progressifs, ni archive FLAC. `outputPlaylist` reste donc `null` : il n'y a pas de
playlist. La sortie est portée par un champ `radioTrack` — l'URL unique, la taille, le
**niveau mesuré** et les **étiquettes** lues sur la source — servi par les **trois
canaux** (poll, SSE, webhook). Voir [le contrat unifié](#le-contrat-unifié).

Sans niveau homogène, chaque enchaînement s'entend et l'auditeur corrige son volume à
chaque titre ; c'est pourquoi la normalisation est faite **à l'ingestion**, une fois par
titre, et non depuis la grille.

### `GET /transcodes/:id/status`

Récupération ponctuelle. `200` avec le **contrat unifié** ci-dessous, `404`
(`E_TRANSCODE_NOT_EXISTS`) si l'`id` est inconnu, `422` si l'`id` n'est pas un UUID v7.

### `DELETE /transcodes/:id`

Reprend **tout ce que le service a produit** pour ce Transcode : le préfixe HLS dans
RustFS, l'**archive** s'il y en a une, le staging local, la progression résiduelle en
Redis et la ligne en base. **La Source de l'appelant n'est jamais touchée** : ingéré par
URL, le master reste son objet (ADR-0007) et il n'y a **pas d'archive** — cette absence
n'est pas une erreur.

| Code  | Quand                                                                          |
| ----- | ------------------------------------------------------------------------------ |
| `204` | Supprimé. Le HLS n'est plus servable.                                          |
| `404` | `id` inconnu — **y compris un `id` déjà supprimé** (`E_TRANSCODE_NOT_EXISTS`). |
| `409` | Un worker détient le Transcode **en ce moment** (`E_TRANSCODE_IN_PROGRESS`).   |
| `422` | L'`id` n'est pas un UUID v7.                                                   |

Un Transcode en file (`PENDING`) est **retiré de la file puis supprimé** ; seul un job
**actif** répond `409`, et ce refus est borné dans le temps — ADR-0008 explique pourquoi
c'est la file, et non la colonne `status`, qui décide.

**Idempotente sur l'effet** : supprimer deux fois laisse le même état, chaque étape
tolérant ce qui manque déjà. Une purge qui relance après un timeout lit `404` comme
« déjà purgé » et `409` comme « réessaie ». C'est **l'appelant** qui décide quand
supprimer (délai de grâce, rétention) ; ce service exécute.

### SSE — canal `transcodes/:id`

Flux temps réel via [`@adonisjs/transmit`](https://docs.adonisjs.com/guides/digging-deeper/transmit)
(endpoints `/__transmit/*`). Le client s'abonne au canal `transcodes/<id>` (jeton requis)
et reçoit **le même payload** à chaque tick de progression et à chaque transition.

### Le contrat unifié

Polling et SSE servent la même forme :

```json
{
  "id": "0191…",
  "status": "PROCESSING",
  "progress": 62,
  "outputPlaylist": "https://media.example.com/hls/0191…/master.m3u8",
  "error": null
}
```

`progress` est un entier `0–100`, ou `null` quand la durée est indéterminée. `outputPlaylist`
est renseigné à `COMPLETED` ; `error` à `FAILED`.

#### Un sixième champ sur le profil `radio`, et seulement là

Sur le profil `radio` (ADR-0010) il n'y a **pas de playlist** : `outputPlaylist` vaut `null`
à `COMPLETED`, par construction. La sortie est donc publiée sous son propre nom,
`radioTrack`, et dans **les trois canaux à la fois** — poll, SSE et webhook :

```json
{
  "id": "01a1…",
  "status": "COMPLETED",
  "progress": 100,
  "outputPlaylist": null,
  "error": null,
  "radioTrack": {
    "url": "https://media.example.com/radio/01a1…/track.m4a",
    "bytes": 2996000,
    "loudness": { "targetI": -16, "inputI": -27.5, "outputI": -16.02, "normalization": "linear" },
    "tags": { "title": "…", "artist": "…", "album": "…" }
  }
}
```

⚠️ **Deux règles que l'appelant doit connaître.**

1. **`outputPlaylist === null` à `COMPLETED` n'est pas une anomalie** — c'est la signature
   de ce profil. Un consommateur qui traite « terminé sans playlist » comme une panne
   classera **chaque** transcodage radio réussi en échec. C'est **le profil du dépôt** qui
   dit où regarder : `radioTrack` pour une radio, `outputPlaylist` pour un enseignement.
2. **Le champ est absent, et non `null`, hors de ce profil.** La charge utile d'un
   enseignement reste au champ près la forme à cinq champs qu'elle a toujours servie.

`radioTrack` n'apparaît qu'à `COMPLETED`. La colonne existe plus tôt — dès la fin de
l'encodage, avant l'envoi vers RustFS — mais publier l'URL avant annoncerait des octets qui
ne sont pas encore servables, alors que `COMPLETED` veut précisément dire « lisible depuis
RustFS » (ADR-0004).

> **Le poll porte la sortie parce que c'est un chemin de rattrapage.** Un appelant qui règle
> ses dépôts depuis le snapshot quand un webhook s'est perdu ne trouverait, sans ce champ,
> aucun endroit où relire l'URL, le niveau et les étiquettes : le webhook ne repart pas et
> la passe ne sera pas rejouée.

Le **webhook** part de cette forme et l'**enrichit** (ADR-0009) : il ajoute la durée du média
et, par rendu, l'URL de téléchargement `.aac` et sa taille en octets — que le consommateur
persiste et sert sans faire de `HEAD`. `downloads` est peuplé à `COMPLETED`, vide à `FAILED`.

Sur le profil **`radio`** (ADR-0010), la charge utile porte à la place le champ
`radioTrack` décrit ci-dessus — le **même** que le poll et le SSE, et **seulement** sur ce
profil : la charge d'un enseignement reste au champ près celle d'aujourd'hui.

```json
{
  "id": "01a1…",
  "status": "COMPLETED",
  "progress": 100,
  "outputPlaylist": null,
  "error": null,
  "durationSeconds": 187.25,
  "downloads": [],
  "radioTrack": {
    "url": "https://media.example.com/radio/01a1…/track.m4a",
    "bytes": 2996000,
    "loudness": { "targetI": -16, "inputI": -27.5, "outputI": -16.02, "normalization": "linear" },
    "tags": { "title": "…", "artist": "…", "album": "…" }
  }
}
```

`loudness` peut valoir `null` : un chiffre de niveau qu'on n'a pas mesuré se recopierait
dans un tableau de bord et s'y défendrait.

```json
{
  "id": "0191…",
  "status": "COMPLETED",
  "progress": 100,
  "outputPlaylist": "https://media.example.com/hls/0191…/master.m3u8",
  "error": null,
  "durationSeconds": 321.5,
  "downloads": [
    { "name": "low", "url": "https://media.example.com/dl/0191…/low.aac", "bytes": 2600000 },
    { "name": "mid", "url": "https://media.example.com/dl/0191…/mid.aac", "bytes": 5100000 },
    { "name": "high", "url": "https://media.example.com/dl/0191…/high.aac", "bytes": 7700000 }
  ]
}
```

---

## Cycle de vie & notifications

```
PENDING ──▶ PROCESSING ──▶ COMPLETED     (master.m3u8 + segments servables depuis RustFS)
                    └────▶ FAILED         (pas de piste audio, conteneur illisible, ou échec d'encodage)
```

- **Échec permanent** (pas d'audio) : `FAILED` immédiat, **sans retry**.
- **Échec transitoire** (I/O, OOM…) : **3 tentatives** backoff, puis `FAILED`.
- Sur `COMPLETED` **et** `FAILED`, la source locale est supprimée.
- Aucun état n'est définitif : `DELETE /transcodes/:id` reprend le Transcode à **n'importe
  quel** état, tant qu'aucun worker ne le détient (ADR-0008).

**Trois canaux de notification**, au choix :

1. **Polling** — `GET /transcodes/:id/status`.
2. **SSE** — temps réel, canal `transcodes/:id`.
3. **Webhook** — si `callbackUrl` est fourni à l'upload, un `POST` est émis à la
   finalisation (`COMPLETED` **et** `FAILED`). Corps = le contrat unifié **enrichi** de
   `durationSeconds` et `downloads` (ADR-0009) ; si `callbackSecret` est fourni, la requête
   porte `X-Transcode-Signature: sha256=<hmac>`.
   Livraison par job dédié : succès = `2xx`, timeout 10 s, ~5 tentatives backoff.

Les qualités HLS produites : **3 rendus AAC-LC** — `low` 64 kbps, `mid` 128 kbps,
`high` 192 kbps — plus un `master.m3u8`. Une **archive FLAC** sans perte est conservée dans RustFS.

> Tout ce paragraphe décrit le profil **`teaching`**, le défaut. Le profil `radio` n'a
> qu'une sortie, un seul débit et aucune archive (ADR-0010).

⚠️ **L'archive est encodée dans une passe à part**, par le job d'archivage, après `COMPLETED` —
et **uniquement sur le chemin `POST /upload`**, que cette plateforme n'emprunte pas. Pour une
ingestion par URL, le master déposé _est_ l'archive : le service n'en recopie aucune (ADR-0007),
et le portail ne purge jamais la source d'un dépôt rattaché (son ADR-0033).

> Autrement dit : **aucun FLAC n'est produit en production aujourd'hui**, et ce n'est pas un trou
> — c'est la conservation du fichier d'origine, piste vidéo comprise, décidée ailleurs.

### Savoir où passe le temps

Chaque transcodage **terminé** pose une ligne de journal, en `info`, qui donne la durée de
ses quatre étapes :

```bash
# Le WORKER, pas le serveur — et la couleur alterne à chaque déploiement.
for c in blue green; do sudo docker logs "eenv-stream-worker-$c" 2>&1 | grep 'terminé en'; done
```

> ⚠️ **C'est le worker qui transcode**, jamais le serveur : celui-ci accepte le
> dépôt et met en file, `transcode:work` fait le travail. Chercher la ligne dans
> `eenv-stream-blue` ne rend rien, et ce rien ressemble à « la mesure ne marche
> pas ». La couleur, elle, bascule à chaque déploiement — d'où la boucle sur les
> deux. Et les journaux d'un conteneur **recréé** repartent de zéro : un worker
> redéployé ce matin ne sait rien du sermon d'hier.

Deux lignes par sermon : la passe de **service**, puis celle de l'**archive**.

> Pour une ingestion par **URL**, la seconde n'a rien à archiver et le dit :
> `"note": "rien à mesurer"`, sans aucun rapport au temps réel. Une ligne sans chiffres doit se
> distinguer d'une ligne dont les chiffres se sont perdus.

```json
{
  "transcode": "01a0…",
  "regime": "depot",
  "audioSeconds": 6438,
  "realtimeFactor": 6.4,
  "totalMs": 1065946,
  "msg": "transcode 01a0… terminé en 1065.9 s",
  "phases": {
    "probe": 567,
    "encode": 1006396,
    "uploadHls": { "ms": 55459, "items": 3223 },
    "uploadDownloads": { "ms": 3440, "items": 3 }
  }
}
```

Trois champs font le travail :

- **`realtimeFactor`** — combien de fois le temps réel. C'est le seul chiffre qui dise si
  l'encodage est rapide ou lent : « 1006 s » ne veut rien dire sans la durée de l'audio.
  Un seul flux AAC fait plusieurs dizaines de fois le temps réel ; **6,4× est la signature
  d'encodages sérialisés dans un même fil**.
- **`regime`** — **par où ffmpeg a lu la source**, et non comment l'enseignement a été déposé.
  ⚠️ Un administrateur qui **téléverse un fichier** produit `url` : le portail range le média
  dans RustFS puis remet au service une **URL présignée**. `fichier` désigne `POST /upload`, que
  ce service expose et que la plateforme n'appelle jamais.
- **`items`** — le nombre de fichiers envoyés. Un `uploadHls` long avec beaucoup d'`items` dit
  que le coût est **par fichier** ; peu d'`items` dirait l'inverse.

- **`encodeFactor`** — le même rapport, mais sur la **seule** étape d'encodage.
- **`download`** — le **rapatriement de la source**, chronométré à part depuis que la copie
  locale existe, avec ses octets et son débit. C'est l'étape que ffmpeg confondait avec
  l'encodage : il lit une URL _pendant_ qu'il encode, et les deux durées n'en faisaient qu'une.

> **Mesuré les 28 et 29/09/2026**, sur deux sermons :
>
> |                | audio  | encode          | ×encode | envoi HLS            |
> | -------------- | ------ | --------------- | ------- | -------------------- |
> | 1 h 47         | 6438 s | 1006 s (94,4 %) | **6,4** | 55 s · 3223 fichiers |
> | 1 h 32 (`url`) | 5533 s | 978 s (95,5 %)  | **5,7** | 42 s · 2773 fichiers |
>
> Paralléliser l'envoi — le réflexe — aurait gagné moins d'une minute sur dix-huit. C'est cette
> mesure qui a évité d'optimiser les 5 %.
>
> Les deux venaient du portail, donc en `url`, donc **sans archive FLAC** — c'est le régime de
> _tous_ les transcodages de cette plateforme. Ils tournent au même rythme, et le FLAC n'y était
> pour rien : il n'y en a jamais eu. Ce qui reste, ce sont **six encodages AAC qui se suivent
> dans un même fil** (trois rendus HLS, trois `.aac`), à ~34× le temps réel chacun.
>
> La source est lue depuis le RustFS de **la même machine** : le réseau n'est pas en cause.

> Cette mesure existe parce que le service ne mesurait rien et qu'on optimisait de mémoire.
> Deux des trois soupçons habituels ne s'appliquent même pas ici : il n'y a pas de `-re` dans
> ce dépôt (donc pas de lecture bridée au temps réel), et il n'y a pas de flux RTMP dans la
> plateforme — le direct vient de YouTube, ce service ne fait que du VOD.

---

## Authentification

Le service **ne connaît rien** de l'authentification (ADR-0003) : un middleware relaie le
jeton porteur vers un **endpoint configuré** (`AUTH_VERIFY_URL`) et n'autorise la requête
que si la réponse correspond au **statut attendu** (et, en option, à un **corps attendu**).
Un jeton valide suffit — aucun cloisonnement par propriétaire. Les résultats sont mis en
cache dans Redis pour un court TTL. `/upload`, `/transcodes/*` et le canal SSE sont gardés.

---

## Prérequis

- **Node 24**, **ffmpeg/ffprobe** (build complet).
  > **ffmpeg ≥ 7 en production.** Sa passe écrit six sorties (trois rendus HLS, trois `.aac`) et
  > c'est la version 7.0 qui les encode **en parallèle**, un fil par sortie. Sous ffmpeg 5, elles
  > se suivaient : mesuré, 6,1× le temps réel contre 55× pour un encodage seul sur la **même**
  > machine. L'image part donc de `node:24-trixie-slim` (ffmpeg 7.1) et non de `bookworm` (5.1).
- **PostgreSQL**, **Redis**, **RustFS** (ou tout S3-compatible).
- Un **endpoint de vérification de jeton** joignable (`AUTH_VERIFY_URL`).

---

## Développement local

```sh
npm install
cp .env.example .env          # renseigner APP_KEY, DB_*, REDIS_*, RUSTFS_*, AUTH_VERIFY_URL

node ace migration:run        # applique les migrations et régénère database/schema.ts

# deux process séparés :
npm run dev                   # serveur HTTP (HMR)
npm run worker                # worker d'encodage (node ace transcode:work)
```

- `APP_KEY` : `node ace generate:key`.
- `npm run typecheck`, `npm run lint`, `npm run format`.

> `database/schema.ts` est **auto-généré** par `migration:run` (introspection). Ne pas
> l'éditer à la main ; les modèles étendent les classes `*Schema` générées.

---

## Déploiement (Docker)

Les datastores (**Postgres, Redis, RustFS**) sont **externes** : l'image ne contient que
l'app et les joint via variables d'environnement.

```sh
cp .env.docker.example .env.docker    # renseigner APP_KEY, AUTH_VERIFY_URL, DB_*, REDIS_*, RUSTFS_*
docker compose --env-file .env.docker up -d --build
```

La stack lance : un one-shot **createbucket** (garantit le bucket sur RustFS), un one-shot
**migrate**, puis **server** et **worker**. Les hôtes par défaut visent
`host.docker.internal` (surchargeables). L'image est multi-stage sur `node:24` avec ffmpeg
complet ; `tini` assure un arrêt propre (drain des jobs BullMQ sur `SIGTERM`).

Construire / lancer un rôle isolément :

```sh
docker compose --env-file .env.docker run --rm migrate
docker compose --env-file .env.docker up -d server worker
```

---

## Servir le HLS avec Caddy

`outputPlaylist` est une **URL absolue** `<HLS_PUBLIC_BASE_URL>/hls/<id>/master.m3u8`
(ADR-0006) — `HLS_PUBLIC_BASE_URL` est la porte publique (Caddy/CDN). En production Caddy
est un **front door indépendant** (hors de cette compose) : le [`Caddyfile`](./Caddyfile)
sert `/hls/*`
**depuis le bucket RustFS** (S3 path-style) et proxifie tout le reste (upload, statut, SSE)
vers l'app. On le lance à côté de la stack, en pointant l'app et RustFS :

```sh
APP_UPSTREAM=host.docker.internal:3333 \
RUSTFS_ENDPOINT=http://host.docker.internal:9000 \
RUSTFS_BUCKET=streaming-service \
caddy run --config ./Caddyfile
# ou: docker run -p 8080:80 -v $PWD/Caddyfile:/etc/caddy/Caddyfile:ro -e APP_UPSTREAM=… caddy:2
```

Les préfixes `hls/`, `dl/` et `radio/` du bucket sont rendus **lisibles anonymement** par le
one-shot `createbucket` (`mc anonymous set download …/hls`, `…/dl`, `…/radio`) ; l'archive
FLAC (`archives/`) reste privée.

⚠️ **Jamais d'`encode` dans les blocs `/dl/*` et `/radio/*`** : compresser ces octets casse
la reprise de téléchargement par plage (spike #184), et l'antenne se déplace dans le
fichier. La compression est déclarée dans le seul bloc fourre-tout.

---

## Variables d'environnement

| Variable                                                           | Requis | Défaut             | Rôle                                                                                 |
| ------------------------------------------------------------------ | ------ | ------------------ | ------------------------------------------------------------------------------------ |
| `APP_KEY`                                                          | ✅     | —                  | Clé applicative AdonisJS.                                                            |
| `HOST` / `PORT`                                                    | —      | `0.0.0.0` / `3333` | Bind du serveur.                                                                     |
| `APP_URL`, `LOG_LEVEL`, `TZ`                                       | —      |                    | Divers.                                                                              |
| `DB_HOST` `DB_PORT` `DB_USER` `DB_DATABASE`                        | ✅     |                    | Postgres. `DB_PASSWORD` optionnel.                                                   |
| `REDIS_HOST` `REDIS_PORT`                                          | ✅     |                    | Redis. `REDIS_PASSWORD` optionnel.                                                   |
| `WORKER_CONCURRENCY`                                               | —      | `1`                | Transcodages en parallèle par worker.                                                |
| `RUSTFS_ENDPOINT`                                                  | ✅     |                    | Endpoint S3 de RustFS.                                                               |
| `RUSTFS_ACCESS_KEY` `RUSTFS_SECRET_KEY` `RUSTFS_BUCKET`            | ✅     |                    | Accès + bucket. `RUSTFS_REGION` optionnel (`us-east-1`).                             |
| `HLS_PUBLIC_BASE_URL`                                              | ✅     |                    | Base publique du HLS (Caddy/CDN) ; `outputPlaylist` = `<base>/hls/<id>/master.m3u8`. |
| `AUTH_VERIFY_URL`                                                  | ✅     |                    | Endpoint de vérification du jeton.                                                   |
| `AUTH_VERIFY_METHOD` `AUTH_VERIFY_STATUS` `AUTH_VERIFY_BODY_MATCH` | —      | `GET` / `200` / —  | Critères de validation.                                                              |
| `AUTH_CACHE_TTL`                                                   | —      | `60`               | TTL (s) du cache de vérification.                                                    |

---

## Décisions & vocabulaire

- **[`CONTEXT.md`](./CONTEXT.md)** — glossaire du domaine (Transcode, Source, Archive audio,
  Rendu, HLS output, RustFS, canal SSE, webhook…).
- **[`docs/adr/`](./docs/adr/)** — décisions structurantes :
  - `0001` sortie audio-only
  - `0002` `id` généré serveur (UUID v7)
  - `0003` vérification de jeton déléguée
  - `0004` RustFS origine de diffusion + pipeline en 2 jobs
  - `0005` webhook de complétion
  - `0006` `outputPlaylist` est une URL absolue
  - `0007` ingestion par URL : la Source reste chez l'appelant, pas d'archive
  - `0008` suppression : c'est la file, pas `status`, qui décide (409 si un worker
    détient le Transcode)
  - `0009` rendus progressifs `.aac` pour le téléchargement hors ligne
  - `0010` profil `radio` : une sortie unique, normalisée en niveau à l'ingestion

### Structure

Module `app/transcodes/` (couches `controllers` → `actions` → `transformers`, les _actions_
étant la seule couche qui touche les modèles), plus `services`, `queues`, `support`,
`exceptions`. Le worker (`commands/transcode_worker.ts`) draine trois files : transcodage,
webhook et archivage.
