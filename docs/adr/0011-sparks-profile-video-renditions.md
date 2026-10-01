# Profil « sparks » — deux rendus, segments de 5 s, et la vidéo s'ouvre

Les annonces de la plateforme reçoivent l'audio **et la vidéo**. Le portail en est le
composeur, le mobile le lecteur ; ce service fait ce qu'il a toujours fait — préparer les
fichiers et les poser sur RustFS — mais une annonce filmée au téléphone n'a ni les besoins
d'un sermon ni ceux d'un titre de l'antenne.

`POST /transcodes` accepte donc un troisième profil. `teaching` et `radio` ne changent pas
d'un octet.

```text
hls/<id>/master.m3u8        ← deux rendus, segments de 5 s
hls/<id>/{low,high}/        ← index.m3u8 + seg_%03d.ts
hls/<id>/poster.jpg         ← la vignette, extraite de la vidéo (nouveau)
```

> ⚠️ **Cet ADR contredit l'ADR-0001, et l'amende explicitement.** Voir
> [son amendement du 2026-10-01](0001-audio-only-hls-output.md) : « sortie audio
> uniquement » était une décision **sur le service**, elle devient une décision **sur les
> profils**. `teaching` et `radio` continuent de jeter la piste vidéo ; ce profil
> l'encode. La phrase à ne plus écrire est « une vidéo est un simple conteneur » : elle
> n'est vraie que de deux profils sur trois.

## Décision 1 — **deux** rendus, et des segments de **5 s** : deux molettes distinctes

C'est la confusion la plus facile à faire, et elle a déjà été corrigée ailleurs sur la
plateforme (même leçon que MediaMTX, où le correctif a été d'écrire que les deux réglages
sont indépendants).

- **La durée de segment fixe le démarrage.** Un lecteur ne produit rien avant d'avoir un
  segment entier. Un sermon d'une heure est choisi puis écouté jusqu'au bout : une seconde
  de plus au démarrage se paie une fois, et des segments longs font moins de fichiers à
  pousser (3223 pour 1 h 47, voir le README). Un Spark dure trente secondes, s'enchaîne
  d'un tap, et son démarrage **est** l'essentiel de son expérience. D'où 5 s contre 6.
- **Le nombre de rendus protège les réseaux faibles.** Des segments courts sur un débit
  trop haut se téléchargent simplement plus lentement qu'ils ne se jouent. Le parc va de
  la 4G du siège à l'EDGE d'une branche mal desservie : un débit unique revient à choisir
  d'avance qui sera mal servi.

L'échelle, mesurée sur la sortie du banc (40 s, 640×360, 30 i/s) :

| rendu  | largeur max | vidéo  | audio | mesuré sur 40 s     |
| ------ | ----------- | ------ | ----- | ------------------- |
| `low`  | 480 px      | 400 k  | 64 k  | 2504 Ko → ~501 kbps |
| `high` | 720 px      | 1200 k | 96 k  | 6668 Ko → ~1334 kbps |

Deux barreaux et pas trois : un troisième coûterait un encodage de plus **sur le chemin
critique de la publication** (un Spark ne paraît qu'avec son média, et la notification
part à ce moment-là) pour une granularité que l'ABR ne saurait pas exploiter sur trente
secondes.

**Une largeur, et non une hauteur.** Un Spark est filmé au téléphone, donc vertical la
plupart du temps, et regardé plein écran. Brider la hauteur (`scale=-2:720`) ramènerait une
verticale 1080×1920 à 405×720 — illisible — là où la même règle sur une horizontale donne
1280×720, deux fois plus de pixels. La largeur est le côté qui touche les bords de l'écran
dans les deux orientations. Et jamais d'agrandissement : `min(<largeur>, iw)` laisse passer
telle quelle une source déjà plus petite.

## Décision 2 — ⚠️ **les images-clés tombent sur les frontières de segment**, et c'est le piège central

`-hls_time 5` ne découpe pas : il **demande** à découper. Le muxeur HLS ne coupe que sur
une image-clé, et sans contrainte x264 en pose une toutes les 250 images.

**Mesuré au banc**, même source, même `-hls_time 5`, à la seule différence de
`-force_key_frames` :

| | durées de segment annoncées (`#EXTINF`) |
| --- | --- |
| **avec** `-force_key_frames expr:gte(t,n_forced*5)` | 5,000 × 8 |
| **sans** | **8,333 · 8,333 · 8,333 · 8,333 · 6,667** |

8,333 s, c'est-à-dire 250 images à 30 i/s. Et **rien ne le signale** : la playlist est
valide, `#EXT-X-TARGETDURATION` s'ajuste, la vidéo joue. Le démarrage rapide qu'on paie en
segments courts n'existait tout simplement pas.

L'expression `gte(t,n_forced*5)` est choisie plutôt qu'un `-g <images>` parce qu'elle est
**indépendante de la cadence** : une vidéo filmée au téléphone n'a aucune obligation de
garder des i/s constantes, et un GOP exprimé en images aurait dérivé avec elles.

Le banc vérifie ensuite, segment par segment, que la **première image est une image-clé**
(`ffprobe -read_intervals %+#1 -show_entries frame=key_frame`) : c'est ce qui rend un
segment décodable **seul**. Sans cela le lecteur doit remonter au segment précédent pour
trouver une image de référence, donc télécharger deux segments avant d'afficher quoi que ce
soit — et les 5 s n'auraient servi qu'à multiplier les fichiers.

`independent_segments` l'écrit enfin dans la playlist, sinon le lecteur n'ose pas démarrer
ailleurs qu'au début.

## Décision 3 — la durée de segment devient une **propriété du profil**

Elle était une constante, `HLS_SEGMENT_SECONDS = 6`, posée à côté des profils. Trois
profils donnent maintenant trois réponses — 6, 5, et *aucune* — qui ne tiennent plus dans
une constante. `PROFILE_SEGMENT_SECONDS` est une table fermée sur l'union des profils
(`satisfies Record<TranscodeProfile, number | null>`) : **un profil nouveau ne compile pas
tant qu'on n'a pas dit ce qu'il fait de ses segments.**

`null` pour `radio`, et ce n'est pas un oubli : sa sortie est un fichier, pas une playlist.
Un `0` ou un `6` inutilisé aurait laissé croire le contraire.

## Décision 4 — la même normalisation que la radio, cible comprise

`loudnorm` en deux passes, **-16 LUFS / -1,5 dBTP**, exactement la cible de l'ADR-0010. La
valeur absolue compte moins que le fait qu'elle soit **la même** : un Spark et un titre de
l'antenne s'enchaînent dans la même oreille, souvent dans la même minute.

### Vérifié par un filtre indépendant, et éprouvé par mutation

`loudnorm` publie ses propres chiffres ; les vérifier avec `loudnorm` serait demander au
témoin de confirmer son témoignage. Le banc mesure donc la playlist produite avec
**`ebur128`**, l'autre filtre d'ffmpeg — et il la mesure sur les octets servis, pas sur une
étape intermédiaire.

Source du banc : bruit rose passé au limiteur, quatre blocs de 10 s à ≈ 8 LU d'écart (la
même famille que le banc radio, et pour les mêmes raisons).

| | mode | I sortie (loudnorm) | I sortie (`ebur128`) | écart fort/faible |
| --- | --- | --- | --- | --- |
| source | — | — | — | **7,9 LU** |
| **deux passes** | `linear` | -15,71 | **-16,1 LUFS** | **8,0 LU — intact** |
| une passe | `dynamic` | -17,18 | — | 5,7 LU — comprimé de 2,2 LU |

**La mutation, et elle est faite.** En retirant la mesure préalable du code (donc en
ramenant la passe à une seule), **deux assertions du banc tombent** : celle du mode
(`dynamic` au lieu de `linear`) et celle de la dynamique (écart ramené à 5,8 LU pour une
source à 8,0 LU). En retirant la contrainte d'images-clés, c'est l'assertion des 5 s qui
tombe. Un banc dont les contre-épreuves passeraient aussi ne prouverait rien.

### ⚠️ Mais `linear` n'est **pas** garanti, et le banc ne fait pas semblant

`loudnorm` n'accorde le gain constant qu'à deux conditions (ADR-0010) : `measured_LRA` ≤
LRA cible, et `measured_TP + gain` ≤ TP cible — la seconde se réduisant à **`TP − I ≤
14,5 LU`**, une propriété de la source et non de son niveau.

Le banc n'assène donc **pas** `normalization === 'linear'`. Il recalcule les deux
conditions depuis la mesure et vérifie la **cohérence** entre la condition et le mode
annoncé ; puis, séparément, il vérifie que la source du banc remplit encore les conditions,
pour que le jour où elle dériverait le test le dise au lieu de rendre vide de sens
l'assertion sur la dynamique. Mesuré ici : facteur de crête **12,45 LU**, plage **8,0 LU** —
les deux conditions passent, de peu pour la première.

Conséquence pour la production, et c'est le chiffre à surveiller : **la proportion de
`normalization: dynamic`**. Un Spark enregistré au téléphone et non traité tombe souvent du
mauvais côté. Si la proportion est forte, c'est un limiteur en amont qu'il faudra discuter,
pas une passe de plus.

## Décision 5 — quatre sous-produits, et presque pas de décodage de plus

La passe d'analyse **lit déjà tout le fichier**. Le graphe de filtres dédouble donc l'audio
(`asplit`) : une branche va à `loudnorm`, l'autre sort en **PCM mono réduit à 1 kHz** sur
`pipe:1`, et Node en tire trente-six hauteurs. Deux kilo-octets par seconde de média —
80 000 octets pour les 40 s du banc.

La **durée** et les **étiquettes** ne passent pas par là : elles se lisent dans l'en-tête du
conteneur par `probe()`, sans décoder un seul échantillon. Les faire sortir du graphe aurait
été les payer plus cher qu'elles ne coûtent.

### La forme d'onde, et pourquoi elle n'est pas décorative

Le client **sait déjà** se replier sur un hachage déterministe du texte quand elle manque.
Ce repli est stable et joli, et **faux** : il dessine des collines là où le Spark commence
par six secondes de silence, et l'auditeur qui voit une barre haute au tout début croit que
la lecture a démarré. Une forme d'onde qui mentirait est pire qu'une absence, parce qu'on ne
peut pas la distinguer d'une vraie. Le banc teste exactement ce cas.

**L'échelle est en décibels, pas en amplitude.** Un passage parlé normal est 20 à 30 dB sous
les crêtes : en amplitude brute il sort à 3 ou 5 sur 100, c'est-à-dire invisible, et la
forme d'onde ne montre plus que les deux coups les plus forts. La barre la plus forte vaut
100, une barre 48 dB plus bas vaut 0. -48 dB plutôt que -60 parce qu'en dessous on remonte
le bruit de fond d'un enregistrement au téléphone — et le silence cesse de se lire comme un
silence, ce qui était le reproche fait au repli.

Chaque barre est l'**efficace** de sa tranche et non sa crête : un clic sur le micro ferait
sinon une barre pleine au milieu du silence.

### La vignette

Extraite quand la source porte une image, **au quart de la durée, plafonné à 3 s** : une
vidéo de téléphone commence presque toujours par du noir, un mouvement de main ou un doigt
sur l'objectif, et un poster noir est exactement ce que l'extraction existe pour éviter.
20 660 octets au banc, à 720 px de large.

**Un échec d'extraction ne fait pas échouer le Spark.** Refuser le dépôt échangerait un
carré noir contre *rien du tout*, et `poster: null` dit ce qui s'est passé là où un `FAILED`
laisserait croire que le média était mauvais. On retente à 0 s, puis on publie `null`.

## Décision 6 — un Spark **sonore** garde deux rendus

« Au plus un média temporel, audio **ou** vidéo » : l'audio seul est un cas normal, pas une
dégradation. Le graphe perd alors sa branche d'image, l'échelle devient 64/128 kbps (les
barreaux `low`/`mid` de l'ADR-0001 : sans vidéo à financer, il n'y a aucune raison de rogner
sur le son du barreau haut), et il n'y a pas de poster.

La bascule est décidée par la **sonde**, pas par une extension — et elle écarte les
**jaquettes embarquées** : un MP3 à pochette expose un flux `video` que ffprobe annonce
comme les autres, et qu'on aurait encodé en diaporama d'une image, avec un débit vidéo et un
poster, pour une pochette. `attached_pic` les sépare, demandé dans le même appel.

## Décision 7 — la sortie vit sous le préfixe HLS **existant**

C'est la différence avec le profil `radio`, qui avait besoin de son propre préfixe parce que
sa sortie n'était pas un jeu HLS. Celle-ci en **est** un. La ranger ailleurs aurait demandé
un second bloc Caddy, un second préfixe anonyme dans la politique RustFS et une seconde
branche de reprise — trois endroits où un oubli rend **404 en `text/html`** (bloc Caddy
manquant) ou **403 en `application/xml`** (politique de préfixe), symptômes dont aucun ne dit
sa cause.

Conséquences de ce choix, toutes gratuites :

- `outputPlaylist` est **rempli** sur ce profil, et il porte ce que son nom dit. La garde
  « terminé sans média » de l'appelant, qui a cinq lecteurs et dont l'oubli les fait tomber
  séparément, n'a donc **rien à apprendre** sur `sparks` ;
- la vignette voyage **dans** le dossier HLS, donc elle part par le même `uploadDirectory`
  et l'effacement du préfixe l'emporte sans qu'on l'ait écrit nulle part ;
- `DELETE /transcodes/:id` fonctionne déjà, inchangé.

Le seul ajout nécessaire est un content-type : sans entrée `.jpg`, la vignette serait servie
en `application/octet-stream` et un navigateur la téléchargerait au lieu de l'afficher.

## Décision 8 — publié par les **trois** canaux, sous un champ qui dit ce qu'il est

`sparkMedia` porte l'URL de la playlist, la vignette, `hasVideo`, la durée, la forme d'onde,
le niveau mesuré et les étiquettes — dans le **poll de statut, le SSE et le webhook**, plus
l'événement du firehose d'ops qui le **relaie sans redire la condition**.

C'est la règle que l'ADR-0006 a posée pour `outputPlaylist` et que l'ADR-0010 a dû corriger
après coup : **le portail règle un dépôt depuis le snapshot de statut quand un webhook a été
perdu** (son réconciliateur périodique). Un champ réservé au webhook rendrait un dépôt dont le
webhook se perd **définitivement irrécupérable** — ni la forme d'onde, ni le niveau, ni la
vignette ne se relisent ailleurs, le webhook ne repart pas, et la passe ne sera pas rejouée.
Il n'y avait aucune raison de refaire l'erreur pour le découvrir une seconde fois.

`playlist` redit `outputPlaylist` **exprès** : un consommateur qui lit `sparkMedia` n'a pas à
savoir qu'une moitié de sa réponse est dans un autre champ. Même raisonnement que
`radioTrack.durationSeconds`.

`sparkMedia` est **absent**, et non `null`, hors de ce profil, et il n'est publié qu'à
`COMPLETED` : la ligne le porte plus tôt (voir ci-dessous), mais `COMPLETED` veut dire
« lisible depuis RustFS » (ADR-0004).

⚠️ **`type` et non `interface`, et récursivement** — `SparkMedia`, `LoudnessReport`,
`MediaTags`. Le payload doit rester assignable au `Broadcastable` de Transmit, donc indexable
par `string`, et TypeScript n'accorde cette signature d'index implicite qu'aux alias. Une
`interface` ici casse `npm run typecheck` dans `TranscodePublisher`, et le compilateur
**désigne mal le coupable** : il accuse le payload, à deux fichiers du champ fautif.

## Décision 9 — le profil est porté par les **trois** mêmes endroits, et la contrainte de la base aussi

Le champ de la requête, la colonne `transcodes.profile`, la charge des deux files — comme
`radio`, facultatif dans les deux derniers parce qu'**un job déjà en file au moment d'une
bascule bleu/vert a été écrit par la version précédente** et doit être traité comme un
enseignement, pas faire planter le worker.

⚠️ **Et la contrainte `CHECK` doit être rouverte, pas seulement l'union TypeScript.**
`table.enum('profile', […])` avait posé `CHECK (profile IN ('teaching','radio'))`. Ajouter
`sparks` au type du code compile, passe tous les tests qui ne touchent pas la base, et
**échoue au premier dépôt réel** — à l'`INSERT`, c'est-à-dire du côté du portail, qui ne
saura pas pourquoi. Le défaut, lui, ne bouge pas : il reste `teaching`, posé par Postgres.

## Consequences

- **Une colonne de plus** : `spark_media` (jsonb). Un blob et non sept colonnes, pour la
  raison des blobs `downloads` et `radio_track` : un ensemble toujours écrit et lu d'un bloc,
  qui épouse la charge du webhook au champ près.
- **`spark_media` est écrit avant `COMPLETED`**, comme `radio_track` et pour la même raison :
  le niveau de sortie n'existe que dans la sortie d'erreur de ffmpeg, la forme d'onde que
  dans le tuyau de la passe d'analyse, et les étiquettes que sur une source rendue juste
  après l'encodage. Les garder en mémoire les perdrait au premier hoquet de RustFS — la
  tentative suivante trouverait `master.m3u8` sur le disque, sauterait l'encodage (ce qu'on
  veut) et publierait un Spark sans forme d'onde ni niveau.
- **Le point de reprise ne change pas** : `master.m3u8`, comme un enseignement. Il n'y a
  aucune taille à remesurer — un jeu HLS est un arbre, pas un fichier — et les sous-produits
  se relisent sur la ligne.
- **Pas de rendus progressifs** (ADR-0009) : il n'y a pas de client hors ligne à servir.
  **Pas d'archive FLAC** (ADR-0007) : le master reste l'objet de l'appelant. La garde de
  `ArchiveTranscode` est d'ailleurs passée en **liste blanche** (`=== 'teaching'`) : écrite
  `!== 'radio'`, elle avait laissé `sparks` du bon côté sans que personne l'ait décidé, et la
  question se reposera au prochain profil.
- **Le `tsconfig.json` exclut `storage/`.** Un segment HLS s'appelle `.ts`, et `tsc` les lit
  comme du TypeScript : un banc interrompu avant son nettoyage faisait rougir
  `npm run typecheck` avec « Invalid character » sur des octets vidéo, à des kilomètres du
  code touché.
- **Rien à changer côté Caddy ni côté politique de bucket** — voir la décision 7. C'est le
  bénéfice le plus concret du choix de préfixe.
- **`POST /upload` n'accepte toujours pas de profil.** Le portail n'appelle que
  `POST /transcodes`.
- **Ce service ne connaît pas les annonces.** `sparks` est le nom d'un régime d'encodage ; ni
  le mot « annonce », ni le modèle du portail, ni le composeur n'entrent ici. Le libellé
  « Sparks » lui-même est un mot de façade, posé par le vocabulaire réglable du portail.

## Le coût, mesuré — et sur la version qui diffuse

Le dépôt a payé cher une leçon là-dessus : lors de l'affaire ffmpeg, **le banc tournait sous
une version qui parallélisait déjà** alors que la production non, et il a donc **démenti à
tort** la bonne hypothèse. Deux fausses pistes ont été suivies avant qu'une mesure *dans le
conteneur* ne rétablisse la vérité. Le banc a donc été rejoué dans `node:24-trixie-slim`.

40 s de 640×360 à 30 i/s, bruit rose limité, Apple Silicon :

| | analyse | encodage (2 rendus) | vignette | total | × temps réel |
| --- | --- | --- | --- | --- | --- |
| ffmpeg 9.0.1 (poste de dev) | 2,0 s | 3,8 s | 0,34 s | **6,1 s** | 6,5 |
| **ffmpeg 7.1.5 (image de production)** | 1,5 s | 5,0 s | 0,24 s | **6,7 s** | 6,0 |

Et les faits que le banc assied, version par version :

| | mode 2 passes | mode 1 passe | écart source → 2p → 1p | I sortie (`ebur128`) | `#EXTINF` avec / sans images-clés forcées |
| --- | --- | --- | --- | --- | --- |
| ffmpeg 9.0.1 (dev) | `linear` | `dynamic` | 7,9 → 8,0 → 5,7 | -16,1 | 5,000 / **8,333** |
| **ffmpeg 7.1.5 (prod)** | `linear` | `dynamic` | 7,9 → 8,1 → 5,8 | -16,1 | 5,000 / **8,333** |

Les deux versions concordent au dixième de LU, y compris sur le piège des images-clés et sur
la taille du tuyau de forme d'onde (80 000 octets de part et d'autre). Les chiffres de cet ADR
sont donc reproductibles sur l'image qui diffuse.

Un mot sur l'ordre de grandeur : **6× le temps réel**, c'est-à-dire qu'un Spark de trente
secondes est prêt en cinq. C'est le même ordre que le régime des enseignements (6,4×) alors
que celui-ci n'encode pas d'image — la différence est que ce profil-ci décode deux fois et en
encode deux. L'analyse pèse un tiers du total, et elle rapporte quatre sous-produits.
