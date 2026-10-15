# Reprise par plage : Caddy est transparent, mais RustFS ignore `If-Range`

**Verdict : `Range` / `ETag` / `206` sont OK de bout en bout. Aucun correctif Caddy n'est
nécessaire — le `Caddyfile` n'avale rien.** Une seule déviation, et elle vient de l'origine, pas
du front : **RustFS ignore l'en-tête `If-Range`**. Le garde-fou de la reprise ne peut donc pas
être délégué au serveur ; il est à la charge du client, et la mesure dit exactement avec quoi.

Tout ce qui suit a été mesuré **sur la production**, le 2026-10-15, depuis un poste extérieur,
sur un `.aac` déjà en ligne — aucun fichier n'a été déposé pour l'occasion.

## Le chemin mesuré — et il n'y a pas de CDN

```sh
dig +short stream.eenv.brainsial.com eenv.brainsial.com s3.brainsial.com
# 169.58.188.16  (le même enregistrement A pour les trois — le VPS lui-même)
```

La réponse porte `via: 1.1 Caddy`, `x-amz-request-id`, `x-amz-version-id`, et **aucun** en-tête
de bord (`cf-ray`, `x-cache`, `age`). La chaîne complète est donc :
**client → Caddy (TLS, HTTP/2) → `reverse_proxy` → RustFS `127.0.0.1:9000`**, deux maillons, pas
trois. Le risque « un CDN avale le `Range` » signalé par l'ADR-0009 **n'existe pas aujourd'hui** :
il n'y a rien devant Caddy. Le jour où l'on en pose un, cette note est le protocole à rejouer.

Témoin : `GET https://stream.eenv.brainsial.com/dl/01a0eaf7-798a-745f-a64d-5c898261a318/low.aac`
— 42 814 825 octets, `content-type: audio/aac`, `etag: "283ee6cdc91a06e74e837c2cd5c3ef22"`,
`last-modified: Tue, 29 Sep 2026 02:35:49 GMT`. Les trois rendus du même Transcode pèsent
42 814 825 / 84 413 325 / 125 989 405 octets, soit un rapport **1 : 1,97 : 2,94** — l'échelle
64/128/192 de l'ADR-0001 est bien celle qui est servie.

## Ce que l'origine tient

| Requête | Attendu | Mesuré |
| --- | --- | --- |
| `curl -r 100-200 <url>` | `206` + `Content-Range` | **`206`**, `content-range: bytes 100-200/42814825`, `content-length: 101` |
| en-tête de l'objet entier | `Accept-Ranges: bytes` | **`accept-ranges: bytes`** |
| `ETag` sur 5 `HEAD` | stable | **5/5 identiques**, et le même sur une réponse `206` |
| `curl -r -1024` (suffixe) | `206` | **`206`**, `content-range: bytes 42813801-42814824/42814825` |
| `curl -r 999999999-…` | `416` | **`416`** |
| `If-None-Match: <etag>` | `304` | **`304`** |
| `If-Match: "<faux>"` | `412` | **`412`** |
| `Accept-Encoding: gzip` + `Range` | pas de compression | **`206`, aucun `content-encoding`** |

La dernière ligne est celle qui valide le `Caddyfile` : en demandant explicitement
`gzip, deflate, zstd, br` sur un `.aac`, la réponse reste un `206` **sans aucun
`content-encoding`**. Le commentaire « ⚠️ jamais d'`encode` ici » de
`deploy/caddy/eenv-stream.caddy` n'était pas une précaution théorique : **il est tenu, et c'est
mesurable depuis l'extérieur**. En revanche l'`encode` du bloc fourre-tout n'a pas pu être
observé en miroir : toutes les réponses de l'app joignables sans jeton font moins de 512 octets
(`/` → 9, un 404 → 25 à 42), c'est-à-dire sous le `minimum_length` par défaut de Caddy. Son
existence est donc lue dans le fichier, pas mesurée — ce qui compte ici est l'absence côté
`/dl/*`, et celle-là est mesurée.

## Ce que l'origine ne tient pas

### `If-Range` est ignoré — la protection doit être côté client

```sh
curl -r 1000-1099 -H 'If-Range: "faux0000000000000000000000000000"' <url>   # → 206 (RFC : 200)
curl -r 1000-1099 -H 'If-Range: Mon, 01 Jan 2024 00:00:00 GMT' <url>        # → 206 (RFC : 200)
```

Les deux formes — validateur fort et date — sont **ignorées** : RustFS sert la plage demandée
quoi qu'il arrive. Pourtant `If-None-Match` et `If-Match` fonctionnent (`304`, `412`) : ce n'est
donc pas « pas de requêtes conditionnelles », c'est **`If-Range` en particulier** qui manque.

Conséquence pour le moteur de téléchargement : **armer `If-Range` ne coûte rien mais ne protège
de rien.** Le filet, c'est l'`ETag` — que la réponse `206` **porte** (vérifié). Le moteur doit
donc comparer l'`ETag` du `206` de reprise à celui qu'il avait mémorisé, et **repartir de zéro
s'ils diffèrent**, au lieu de supposer qu'un `200` l'aurait averti.

Le risque réel reste faible par construction : l'URL contient le `transcodeId` (ADR-0009), donc
un re-transcodage produit une **autre** URL et ne peut pas recoller des octets d'une autre
version sous la même adresse. L'ignorance d'`If-Range` ne devient dangereuse que si l'on viole
un jour cette règle de nommage.

### `HEAD` + `Range` répond `200`, pas `206` — le piège de la commande d'acceptation

```sh
curl -r 100-200 -I <url>   # → HTTP/2 200, content-length: 42814825, pas de Content-Range
curl -r 100-200    <url>   # → HTTP/2 206, content-range: bytes 100-200/42814825
```

RustFS n'applique pas le `Range` sur un `HEAD` (S3 d'AWS, lui, renvoie `206`). **`curl -I` n'est
donc pas un test valide du support des plages sur cette origine** — c'est pourtant la commande
inscrite dans la fiche #184, et telle quelle elle aurait fait conclure à une panne inexistante.
Tout contrôle futur doit utiliser un `GET` (`-r … -D - -o /dev/null`).

### Plages multiples : `400`

`curl -r 0-99,200-299` → `400` (XML S3). Le moteur ne doit demander **qu'une plage à la fois**.
C'est sans conséquence : une reprise est par nature un unique `bytes=<n>-`.

## La preuve qui compte : recoller et comparer

Deux recollages, checksum `sha256` contre un téléchargement contigu de référence.

**Fenêtré** — 4 × 2 Mio contre un seul tir de 8 Mio :

```sh
curl -r 0-8388607 -o fenetre.bin <url>
for i in 0 1 2 3; do curl -r $((i*2097152))-$(((i+1)*2097152-1)) -o w$i.bin <url>; done
cat w0.bin w1.bin w2.bin w3.bin > fenetre-recollee.bin
shasum -a 256 fenetre.bin fenetre-recollee.bin
# 2041c37f4b510dd809bbcb3b93d38282c47c2f394f87091a451eb3be3ead387b  fenetre.bin
# 2041c37f4b510dd809bbcb3b93d38282c47c2f394f87091a451eb3be3ead387b  fenetre-recollee.bin
```

**Fichier entier, coupé à 50 %** — le scénario de la fonctionnalité :

```sh
curl -o entier.aac <url>                                   # référence : 42 814 825 o en 348,7 s
curl -r 0-21407411 -o part1.bin <url>                      # 21 407 412 o, 206
curl -r 21407412- -H "If-Range: $ETAG" -o part2.bin <url>  # 21 407 413 o, 206
# content-range: bytes 21407412-42814824/42814825
# etag: "283ee6cdc91a06e74e837c2cd5c3ef22"   ← le 206 le porte : c'est lui, le garde-fou
cat part1.bin part2.bin > recolle.aac
shasum -a 256 entier.aac recolle.aac
# 814f3dff3d5ba1867115056ac3f19690da50893123ff7c8675ad1f39f15ef91f  entier.aac
# 814f3dff3d5ba1867115056ac3f19690da50893123ff7c8675ad1f39f15ef91f  recolle.aac
cmp entier.aac recolle.aac   # identiques
```

**Byte-exact sur 42,8 Mo, pas sur un échantillon.** Et le prolongement du spike #183 tient aussi
en vrai, sur un fichier venu du réseau et non d'un banc local : `ffprobe` lit le recollé comme un
`aac` de **5 214,17 s à 65 689 bps**, et la moitié tronquée (`part1.bin` seul) comme **2 607,08 s
à 65 690 bps** — exactement la moitié de durée, puisque ADTS l'estime à partir du nombre d'octets.
Un téléchargement interrompu s'écoute donc, et sa barre de lecture ne ment pas.

Les deux autres routes du même front répondent pareil : un segment HLS
(`/hls/<id>/low/seg_000.ts` → `206`, `bytes 10-20/53016`) et le rendu `high`
(`/dl/<id>/high.aac` → `206`, `bytes 10-20/125989405`).

Débit observé depuis ce poste : **≈ 123 ko/s** (42,8 Mo en 348,7 s), soit **six minutes pour un
enseignement de 1 h 27 en 64 kbps**. Ce n'est pas l'objet du spike, mais c'est le chiffre qui dit
pourquoi la reprise n'est pas un luxe.

## Ce qui n'a pas été vérifié

- **Le `Caddyfile` de développement** (racine du dépôt) n'a pas été exercé : il n'a pas tourné
  ici. Ses blocs `/hls|/dl|/radio` sont directive pour directive ceux du bloc de production, et
  c'est le bloc de production qui sert les octets mesurés.
- **Une vraie coupure réseau** (câble arraché, bascule 4G/Wi-Fi) : la coupure a été simulée par
  une plage bornée, pas par un socket tué. Ce qui est prouvé, c'est que les octets recollés sont
  les bons — pas le comportement du client au moment de la rupture, qui est l'affaire du moteur.
- **Les en-têtes de cache** : la réponse ne porte **aucun** `Cache-Control` (mesuré : 0
  occurrence). Rien n'est donc cassé aujourd'hui, mais aucune politique n'est écrite non plus ;
  à trancher le jour où un CDN apparaît, pas avant.
- **`/radio/*`** n'a pas été mesuré faute de clé publique connue depuis l'extérieur (le bucket
  refuse le `ListObjects` anonyme : `403`, et aucun endpoint public ne rend une clé de l'antenne).
  Le bloc est un copié-collé de `/dl/*` — même rewrite, même `reverse_proxy`, pas d'`encode` —
  mais ceci est une lecture de configuration, pas une mesure. `/hls/*`, lui, est mesuré.
- **Un `.aac` déposé pour l'occasion** : aucun. Le témoin est un rendu de production déjà en
  ligne, trouvé en remontant la page publique d'un enseignement jusqu'à son `transcodeId` ; il n'y
  a pas d'accès en écriture au VPS depuis ce poste.

## Conséquences

- **Aucun changement de `Caddyfile`.** Les deux fichiers étaient déjà corrects ; la mesure le
  confirme de l'extérieur. Le commentaire « jamais d'`encode` » gagne le droit de citer un
  résultat plutôt qu'une crainte.
- **L'ADR-0009 est précisé** : son « `If-Range` préservé » est vrai de Caddy et faux de
  l'origine, et le risque CDN est sans objet tant qu'il n'y a pas de CDN.
- **Le moteur mobile hérite d'une règle** : comparer l'`ETag` du `206`, une seule plage par
  requête, ne jamais sonder le support des plages avec un `HEAD`.
- **Le contrôle est rejouable** : `scripts/verifier-reprise.sh <url> [--entier]` refait les sept
  vérifications décisives et compte ses verdicts. C'est ce qu'il faudra lancer le jour où un CDN
  apparaît devant Caddy, ou après une mise à jour de RustFS — la ligne `NOTE If-Range` y est
  volontairement un constat et non un échec : si elle passe un jour à `200`, le moteur mobile
  pourra s'alléger.
