# Profil « radio » — une sortie unique, et le niveau égalisé à l'ingestion

Le portail devient le **programmateur** d'une radio : il tient une grille et dit à
liquidsoap ce qu'il doit diffuser. Ce service garde son rôle — préparer les fichiers et
les poser sur RustFS — mais un morceau de musique n'a pas les besoins d'un sermon.

`POST /transcodes` accepte donc un **profil**. `teaching`, le défaut, est le régime
historique et ne change pas d'un octet. `radio` produit **une seule sortie** :

```text
radio/<id>/track.m4a      ← AAC-LC 128 kbps, 48 kHz, normalisé en niveau (nouveau)
```

Pas de jeu HLS — segmenter une chanson de trois minutes n'apporte rien à un lecteur qui
la lit d'un bout à l'autre. Pas d'archive FLAC — le master reste l'objet de l'appelant
(ADR-0007). Pas de rendus progressifs — il n'y a pas de client mobile à servir hors ligne.

## Pourquoi la normalisation, et pas seulement un rendu unique

C'est la décision structurante, et ce n'est pas une optimisation : **sans niveau
homogène, chaque enchaînement s'entend**, et l'auditeur corrige son volume à chaque
titre. C'est le défaut qui distingue immédiatement une antenne amateur, et il ne se
corrige pas depuis la grille : il se corrige à l'ingestion, une fois par titre. Le faire
après coup demanderait de reprendre toute la discothèque.

## Décision 1 — `loudnorm` en **deux** passes

Une passe mesure (`-f null -`), la seconde applique et écrit. La source est donc décodée
deux fois.

Ce n'est pas un choix de vitesse, c'est un choix de **qualité**, et il ne se réduit pas à
« plus juste » :

- **En une passe**, `loudnorm` ne connaît pas encore le morceau, donc il normalise
  _dynamiquement_ : son gain varie au fil de la lecture. Le niveau moyen sort juste, mais
  une intro calme est poussée et un refrain fort retenu — le filtre **retouche l'intérieur
  des titres**.
- **En deux passes**, la mesure autorise `linear=true` : **un gain constant**, décidé une
  fois, appliqué partout. Les dynamiques du morceau sont intactes et seul son niveau bouge.

Or ce qu'on cherche, c'est l'égalité _entre_ les titres, pas une compression _dans_ les
titres. Le mode dynamique ferait donc les deux, dont un qu'on ne demande pas.

Le dépôt a déjà accepté une double décodification — l'archive FLAC — **avec une mesure à
l'appui**. La même exigence est satisfaite ici. Mesuré sur ffmpeg 9.0.1, bruit rose de
3 min, Apple Silicon :

| passe                 | durée     | vitesse                 |
| --------------------- | --------- | ----------------------- |
| analyse (`-f null -`) | 3,1 s     | —                       |
| application           | 4,1 s     | —                       |
| **deux passes**       | **7,2 s** | **25,1× le temps réel** |
| une passe             | 4,1 s     | 44,3× le temps réel     |

Le second décodage coûte **+76 % de temps de mur**, l'analyse pesant 43 % du total. Le
choix se tient malgré ce surcoût, pour trois raisons :

1. l'ordre de grandeur : un titre de trois minutes est prêt en **7 secondes**. Le régime
   des enseignements tourne à 6,4× le temps réel — la radio reste **quatre fois plus
   rapide que lui alors qu'elle décode deux fois**. Le surcoût se paie sur un budget qui
   n'est pas contraint ;
2. depuis que la source distante est **rapatriée avant d'être encodée**, la seconde
   lecture se fait sur le disque local et non sur le réseau ;
3. la passe d'analyse est chronométrée **sous son propre nom** (`analyseLoudness`), à côté
   de `encode`, dans la ligne de journal existante : les premiers titres réels
   confirmeront ou défairont ce tableau d'eux-mêmes.

### Et le gain, mesuré lui aussi

Le coût ne prouvait rien de ce qu'on achetait avec. Le gain est maintenant **vérifié sur
un fichier produit**, par le groupe « le gain constant, sur une vraie sortie » de
`tests/functional/radio_normalisation.spec.ts`. Source à dynamique réelle, blocs de 10 s
à ≈ 8 LU d'écart, bruit rose passé au limiteur :

|                 | plage source | écart fort/faible           | mode      | I sortie  |
| --------------- | ------------ | --------------------------- | --------- | --------- |
| **deux passes** | 8,0 LU       | **8,0 LU — intact**         | `linear`  | **-16,1** |
| une passe       | 8,0 LU       | 5,7 LU — comprimé de 2,3 LU | `dynamic` | -17,6     |

Les deux passes **préservent la dynamique interne** ; la passe unique la rabote de 2,3 LU,
c'est-à-dire pousse les passages calmes et retient les forts. C'est exactement l'argument
de qualité avancé plus haut, et c'est la première fois qu'un chiffre le soutient. Bonus
non anticipé : la passe unique **rate aussi la cible** de 1,6 dB (-17,6 au lieu de -16),
alors que l'égalité des niveaux est l'objet même de la tranche.

Le test n'est pas complaisant : en lui retirant la mesure préalable — donc en le ramenant
à une passe —, **trois de ses quatre assertions tombent**, dont celle du mode et celle de
la dynamique. C'est ce qui le distingue d'un test écrit pour donner raison au choix déjà
fait.

**Éprouvé sur les deux versions, dont celle de production.** Le poste de développement
tourne sur ffmpeg 9.0.1, l'image de production sur le **7.1 de Debian trixie** (voir le
`Dockerfile`), et `loudnorm` n'a aucune obligation de se comporter pareil. Le banc a donc
été rejoué **dans `node:24-trixie-slim`**, sur `ffmpeg 7.1.5-0+deb13u1` :

|                         | mode 2 passes | mode 1 passe | écart source → 2p → 1p | I sortie 2p |
| ----------------------- | ------------- | ------------ | ---------------------- | ----------- |
| ffmpeg 9.0.1 (dev)      | `linear`      | `dynamic`    | 8,1 → 8,1 → 5,7        | -16,1       |
| **ffmpeg 7.1.5 (prod)** | `linear`      | `dynamic`    | 8,0 → 8,0 → 5,7        | -16,1       |

Les deux versions concordent au dixième de LU, y compris sur la marge de pic (-3,72 dBTP
de part et d'autre) et sur le plafond de 96 kHz sans `-ar`. La conclusion ne dépend donc
pas de la version, et les chiffres de cet ADR sont reproductibles sur l'image qui diffuse.

### ⚠️ Mais le gain constant n'est **pas garanti**, et c'est la vraie découverte

`loudnorm` n'accorde son mode `linear` qu'à **deux conditions**, trouvées au banc :

1. **`measured_LRA` ≤ `LRA` cible (11 LU).** Un gain constant ne peut pas réduire une
   plage : une source qui déborde la cible est traitée en dynamique.
2. **`measured_TP` + gain ≤ `TP` cible (-1,5 dBTP).** Celle-ci mord bien plus souvent, et
   elle est contre-intuitive : elle porte sur le **facteur de crête**, pas sur la
   dynamique. Comme `gain = cible_I − I`, la condition se réduit à
   `TP − I ≤ 14,5 LU` — une propriété de la source, indépendante de son niveau.

Conséquence opérationnelle, et elle n'est pas mince. Mesuré au banc, sur la même famille
de sources :

- bruit rose **nu** : facteur de crête ≈ 14,3 LU — **juste sous** la limite. Il passe, mais
  de peu ;
- bruit rose nu creusé de blocs faibles de 10 s à 14 dB : plage 14,1 LU, donc condition 1
  violée → **`dynamic`** ;
- bruit rose nu creusé de blocs à 8 dB : facteur de crête monté à 15,7 LU, condition 2
  violée → **`dynamic`**.

C'est un piège en tenaille : creuser la source pour lui donner de la dynamique abaisse sa
loudness sans toucher son pic, donc **augmente** son facteur de crête — la propriété même
qui lui ferme le mode linéaire. Il a fallu passer le bruit au **limiteur** pour obtenir à
la fois une vraie plage et `linear`, et c'est ce que fait la source du test.

Autrement dit : **une partie de la discothèque sera normalisée dynamiquement, donc
retouchée à l'intérieur, et le double décodage n'y aura servi qu'à mieux viser la cible.**

Ce n'est pas une raison de revenir à une passe — le second décodage garde alors son
bénéfice de justesse, 1,6 dB mesuré. Mais cela veut dire que le champ
`radioTrack.loudness.normalization` **n'est pas un ornement** : c'est le seul endroit où
l'on apprend qu'un titre donné a été comprimé. Un master de musique commercial, écrêté
avant livraison, tombe du bon côté ; un enregistrement de louange capté en direct et non
traité, probablement pas.

À surveiller en production, donc, sur un chiffre qui existe déjà : la proportion de
`normalization: dynamic` dans les pistes radio. Si elle est forte, c'est un limiteur en
amont de `loudnorm` qu'il faudra discuter, pas le nombre de passes.

Un filet, enfin : si l'analyse ne rend rien d'exploitable — une source silencieuse fait
imprimer `-inf` —, la passe d'application retombe sur le mode dynamique au lieu d'échouer.
Un titre normalisé approximativement vaut mieux qu'un dépôt refusé.

## Décision 2 — le profil est porté par **trois** endroits, et son défaut vit dans la base

Un champ facultatif de la requête, une colonne `profile` sur `transcodes`, et un champ
facultatif de la charge du job.

- **La colonne**, parce que la ligne doit pouvoir dire de quel régime elle relève sans la
  file : un job disparu, rejoué à la main ou drainé ne doit pas emporter cette
  information avec lui.
- **La charge du job**, parce que c'est la raison d'être de `TranscodeJobData` — le worker
  ne relit pas la base.
- **Facultatif dans les deux**, parce qu'un job déjà en file au moment d'une bascule
  blue/green a été écrit par la version précédente : il doit être traité comme un
  enseignement, pas faire planter le worker.

Et surtout : **le défaut est posé par Postgres** (`defaultTo('teaching')`), pas seulement
par le code. C'est ce qui garantit que le fonds déjà transcodé et tout `INSERT` qui omet
la colonne restent exactement dans le régime existant. Un défaut porté par l'application
aurait laissé la colonne `NULL` sur les lignes anciennes, et chaque lecture aurait dû se
souvenir de traduire `NULL` en « enseignement » — jusqu'à celle qui l'oublie.

Corollaire assumé : le profil est **immuable**. Redéposer le même fichier sous l'autre
profil est un autre Transcode, avec son identifiant et ses octets.

## Décision 3 — 128 kbps, un seul débit

Ce fichier **n'est écouté par personne** : liquidsoap le lit depuis le RustFS de la même
machine, le mélange aux autres et **ré-encode** le flux qu'il diffuse. C'est donc un
_master de diffusion_, et la connectivité contrainte de la zone couverte s'applique au
flux sortant de liquidsoap, pas à ce fichier-ci.

Le calibrer sur le débit de l'antenne ferait payer **deux fois** la perte lossy : une fois
ici, une fois à la diffusion. Et 64 kbps est le _plancher_ de l'échelle HLS (ADR-0001),
choisi pour de la louange **diffusée telle quelle** ; commencer une chaîne de deux
encodages au plancher, c'est s'assurer que le second passe dessous.

128 kbps — le barreau `mid`, déjà en production — laisse cette marge pour un coût de
stockage modeste : ≈ 0,96 Mo par minute, ≈ 2,9 Mo pour un titre de trois minutes, ≈ 1,5 Go
pour une discothèque de cinq cents titres.

La cible de niveau est **-16 LUFS / -1,5 dBTP** : la convention de la diffusion en ligne
(AES TD1004) plutôt que le -23 LUFS de la FM, parce que l'antenne est écoutée au téléphone,
souvent dans le bruit. Le -1,5 dBTP laisse de la marge au ré-encodage de liquidsoap, dont
un lossy parti d'un pic à -0,1 fabriquerait des pics inter-échantillons au-dessus de 0.

## Ce que les canaux portent, et ce qu'ils ne portent pas

La sortie est publiée sous un champ `radioTrack` — l'URL unique, la taille en octets, le
**niveau mesuré** et les **étiquettes** de la source — et elle l'est dans **les trois
canaux à la fois** : le poll de statut, le SSE et le webhook. C'est la règle que
l'ADR-0006 a posée pour `outputPlaylist` et il n'y a aucune raison de lui faire exception.

> **Amendement du 29/09/2026 — le webhook seul ne suffisait pas, et c'était un défaut de
> correction.** Cet ADR a d'abord réservé `radioTrack` au webhook, en s'appuyant sur le fait
> que le contrat unifié à cinq champs ne devait pas bouger. Le raisonnement tenait sur la
> forme et manquait le fond : **le portail règle un dépôt depuis le snapshot de statut quand
> un webhook a été perdu** (son réconciliateur périodique). Une sortie radio absente du
> snapshot rendait donc un dépôt dont le webhook s'est perdu **définitivement
> irrécupérable** — l'URL, le niveau et les étiquettes ne se relisent nulle part ailleurs,
> le webhook ne repart pas, et la passe ne sera pas rejouée.
>
> Le champ est donc servi par les trois canaux. L'argument de nommage qui a motivé le refus
> initial reste intact : on n'a rien rangé dans un champ « playlist », on a ajouté un champ
> qui dit ce qu'il est.

> **Second amendement du 29/09/2026 — le firehose d'ops aussi, et la nuance mérite d'être
> écrite.** Après le correctif ci-dessus, l'événement du firehose (`pipeline:events`, la
> surface d'observabilité) gardait ses cinq champs. Le raisonnement était : ce n'est pas un
> chemin de rattrapage, aucune donnée ne s'y perd, et **une forme d'observabilité n'est pas un
> contrat de publication**. Cette dernière phrase est juste. Ce qu'elle ne dit pas — et c'est
> là que le raisonnement cassait — c'est qu'**une surface d'observabilité puisse mentir sans
> conséquence**.
>
> Elle ne peut pas. `outputPlaylist` vaut `null` sur ce profil par construction, donc une page
> d'ops nourrie par ce firehose aurait présenté **chaque radio réussie** comme « terminée sans
> média », c'est-à-dire en panne. La plateforme a une doctrine explicite là-dessus, écrite côté
> portail à propos des pastilles de navigation : **on n'affiche jamais un zéro, parce qu'un
> indicateur qui montre zéro apprend à être ignoré.** Une fausse alerte récurrente est pire
> qu'un silence — elle use l'attention qu'une vraie alerte aura besoin d'emprunter. Ce dépôt a
> déjà payé ce prix avec une sonde durablement rouge qui ne signalait plus rien.
>
> L'événement porte donc `radioTrack`, **sans redire la condition** : il recopie ce que
> `TranscodeTransformer` a laissé passer. Deux règles identiques écrites à deux endroits
> divergent, et celle-ci (« à `COMPLETED` seulement, absente hors profil ») est précisément
> le genre de règle qu'on corrige d'un côté en oubliant l'autre. C'est aussi pourquoi le
> contrat de publication est maintenant un type **nommé**, `TranscodeWirePayload` : le
> firehose s'appuie sur une forme déclarée, pas sur ce que l'inférence a bien voulu produire.
>
> Preuve que la règle n'a pas été dupliquée : les deux cas de test existants du firehose
> n'ont eu **aucune** modification à subir. Un enseignement ne gagne pas un champ parce qu'un
> autre profil est né.

`radioTrack` n'est publié qu'à **`COMPLETED`**. La ligne le porte plus tôt — dès la fin de
l'encodage, avant l'envoi vers RustFS (voir plus bas _pourquoi_ si tôt) — mais publier l'URL
avant annoncerait des octets qui ne sont pas encore servables, alors que `COMPLETED` veut
précisément dire « lisible depuis RustFS » (ADR-0004).

Le niveau publié n'est pas une prédiction : `loudnorm` imprime la loudness du **résultat**
à la fin de la passe qui l'écrit. Aucun décodage de plus n'a été dépensé pour l'obtenir, et
`null` y est possible — un chiffre de niveau qu'on n'a pas mesuré se recopierait dans un
tableau de bord et s'y défendrait.

`radioTrack` est **absent**, et non `null`, hors de ce profil : la charge utile d'un
enseignement doit rester au champ près celle que le portail reçoit aujourd'hui.

`outputPlaylist` vaut `null` sur ce profil, et la colonne reste vide. **Il n'y a pas de
playlist** : y ranger l'URL d'un `.m4a` ferait mentir le nom de la colonne dans les trois
canaux à la fois.

⚠️ **Conséquence pour l'appelant, et elle est piégeuse** : `outputPlaylist === null` à
`COMPLETED` **n'est pas une anomalie** sur ce profil, c'est sa signature. Un consommateur
qui traite « terminé sans playlist » comme une panne classera **chaque** transcodage radio
réussi en échec. C'est le **profil du dépôt** qui dit où regarder — `radioTrack` pour une
radio, `outputPlaylist` pour un enseignement — et cette lecture est à la charge de
l'appelant.

## Pourquoi MP4/M4A, et non l'ADTS des téléchargements

L'ADR-0009 choisit l'ADTS pour une raison précise — le client mobile doit pouvoir jouer un
fichier **à moitié téléchargé**, donc pas d'index central. Cette raison ne s'applique pas
ici : liquidsoap n'ouvre le fichier qu'après `COMPLETED`.

En revanche l'antenne a besoin de la **durée à la seconde** pour calculer ses fondus et ses
coupures, et un ADTS n'en porte aucune : elle y est _estimée_ depuis la taille, avec ≈1 % de
dérive (ADR-0009). Le `moov` d'un MP4 la porte exactement, et elle s'accorde alors au
chiffre publié dans le webhook. Deux sources qui se contredisent de 1 % coûteraient plus
cher que l'index.

## La sonde s'étend

`probe()` rendait `durationSeconds` et `hasAudio` ; elle rend en plus le **débit** du
conteneur et les **étiquettes** (titre, artiste, album), que le portail proposera à
l'administrateur comme valeurs par défaut au dépôt. Tout est demandé dans le même appel :
le JSON était déjà parsé sur place, donc chaque champ coûte une clé, pas un aller-retour.

Deux pièges y sont payés une fois pour toutes : les étiquettes se lisent **à deux niveaux**
(un Ogg les range sur le flux, un MP4 sur le conteneur) et **la casse de leurs clés varie**
(un commentaire Vorbis est écrit `TITLE`). Une lecture naïve marcherait sur un MP3 et
rendrait `null` sur un FLAC.

## Consequences

- **Deux colonnes de plus** : `profile` (non nulle, défaut `teaching`) et `radio_track`
  (jsonb). Un blob et non quatre colonnes, pour la raison qui a valu le blob `downloads` :
  un ensemble toujours écrit et lu d'un bloc, qui épouse la charge du webhook au champ près.
- **`radio_track` est écrit avant `COMPLETED`** — la seule colonne de ce service dans ce
  cas. Le niveau et les étiquettes sont les sous-produits d'une passe que le point de
  reprise ne rejouera pas, et la source dont viennent les étiquettes est rendue juste après
  l'encodage. Les garder en mémoire les perdrait au premier hoquet de RustFS : la tentative
  suivante trouverait la piste sur le disque, sauterait l'encodage — ce qu'on veut — et
  publierait un webhook sans niveau ni étiquettes.
- **Le point de reprise regarde un autre fichier** selon le profil : `master.m3u8` ou
  `radio/<id>/track.m4a`. Un profil qui aurait interrogé le fichier de l'autre aurait
  ré-encodé à chaque tentative.
- **La reprise s'élargit** (ADR-0008) : `DELETE /transcodes/:id` efface aussi
  `radio/<id>/`, **sans regarder le profil**. Un préfixe vide n'efface rien et ce n'est pas
  une erreur, alors qu'une reprise qui se fie à la colonne laisserait des octets servables
  le jour où la colonne et les octets ne s'accordent pas — exactement ce que l'ADR-0008
  reproche à `status`.
- **L'observabilité porte la sortie elle aussi.** L'événement `pipeline:events` gagne le même
  champ conditionnel que le contrat unifié, relayé et non recalculé. Une surface qui affiche
  « terminé sans média » à chaque succès n'est pas neutre : elle fabrique la fausse alerte qui
  fera ignorer les vraies.
- **La porte publique s'élargit** : un bloc `handle /radio/*` dans les deux Caddyfiles, sur
  le modèle de `/dl/*` — CORS, requêtes par plage, et **jamais d'`encode`** (spike #184). Le
  préfixe `radio/` du bucket doit être lisible anonymement, **non signé et permanent** : une
  URL signée n'expirerait pas pendant une pause mais **en pleine diffusion**.
- **`POST /upload` n'accepte pas de profil.** Le portail n'appelle que `POST /transcodes` ;
  ouvrir l'autre chemin aurait ajouté un régime que personne n'emprunte, et une archive FLAC
  de plus à interdire.
- **L'ingestion du direct n'est pas ici** : elle passera par MediaMTX, monté à côté, avec
  une clé validée par l'API du portail.
