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
  *dynamiquement* : son gain varie au fil de la lecture. Le niveau moyen sort juste, mais
  une intro calme est poussée et un refrain fort retenu — le filtre **retouche l'intérieur
  des titres**.
- **En deux passes**, la mesure autorise `linear=true` : **un gain constant**, décidé une
  fois, appliqué partout. Les dynamiques du morceau sont intactes et seul son niveau bouge.

Or ce qu'on cherche, c'est l'égalité *entre* les titres, pas une compression *dans* les
titres. Le mode dynamique ferait donc les deux, dont un qu'on ne demande pas.

Le dépôt a déjà accepté une double décodification — l'archive FLAC — **avec une mesure à
l'appui**. Ici, la même exigence n'est pas satisfaite : **le chiffre n'existe pas encore.**
Cette tranche a été écrite sans exécuter ffmpeg. Trois choses bornent le risque :

1. la seconde lecture est un **décodage**, pas un encodage ; la mesure des phases de ce
   dépôt a montré que l'encodage pèse 94 % d'un transcodage ;
2. depuis que la source distante est **rapatriée avant d'être encodée**, la seconde
   lecture se fait sur le disque local et non sur le réseau ;
3. la passe d'analyse est chronométrée **sous son propre nom** (`analyseLoudness`), à côté
   de `encode`, dans la ligne de journal existante. Le premier titre encodé en production
   donnera donc le rapport de lui-même, et ce choix pourra être défendu ou défait sur un
   nombre plutôt que sur un raisonnement.

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
*master de diffusion*, et la connectivité contrainte de la zone couverte s'applique au
flux sortant de liquidsoap, pas à ce fichier-ci.

Le calibrer sur le débit de l'antenne ferait payer **deux fois** la perte lossy : une fois
ici, une fois à la diffusion. Et 64 kbps est le *plancher* de l'échelle HLS (ADR-0001),
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
l'encodage, avant l'envoi vers RustFS (voir plus bas *pourquoi* si tôt) — mais publier l'URL
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
coupures, et un ADTS n'en porte aucune : elle y est *estimée* depuis la taille, avec ≈1 % de
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
