# Sortie HLS audio uniquement — la vidéo n'est qu'un conteneur

Ce service produit **exclusivement** du HLS **audio** (AAC-LC). Les fichiers vidéo
(`.mp4`, `.mkv`, `.mov`…) sont acceptés par commodité, mais `ffmpeg` **jette la piste
vidéo** (`-vn`) et n'extrait que l'audio à la volée pendant la génération du HLS — aucune
passe d'extraction séparée pour fabriquer le HLS. C'est un service de diffusion audio
(enseignements parlés, louange).

> **Amendement du 2026-08-12 — « permanente » était trop fort.** Cet ADR disait « on ne
> produira **jamais** de HLS vidéo » ; l'appelant (`new-life-server`) a explicitement retenu
> **l'audio aujourd'hui, la vidéo plus tard**. La frontière est donc **actuelle**, pas
> définitive : elle tient tant que la bande passante togolaise commande, et l'échelle de
> rendus est le seul endroit à rouvrir le jour venu — HLS sait porter des variantes vidéo
> **et** une variante audio dans un même `master.m3u8`, donc l'URL publiée n'aura pas besoin
> d'un jumeau.
>
> **Ce qui décide si le fonds déjà transcodé sera ré-encodable, ce n'est pas cet ADR, c'est
> le chemin d'ingestion** ([ADR-0007](0007-url-ingestion-the-source-stays-with-the-caller.md)) :
> par **upload**, la piste vidéo est perdue pour toujours (archive FLAC, Source détruite) ;
> par **URL**, elle survit dans l'objet de l'appelant — s'il le conserve.

> **Amendement du 2026-10-01 — c'était une décision sur LE SERVICE ; elle devient une
> décision sur LES PROFILS.** L'issue #49 ouvre la vidéo, et cet ADR ne peut pas être
> contourné en silence : un ADR qu'on contourne mentira à sa prochaine lecture.
>
> **La question posée, et la réponse.** « Sortie audio uniquement » portait-il sur le
> service ou sur les enseignements ? Sur **le service** — le titre dit « Ce service
> produit *exclusivement* du HLS audio », la conséquence ci-dessous fait d'un fichier
> sans piste audio un échec métier *quel que soit* le dépôt, et toute la chaîne (archive
> FLAC, échelle de trois rendus, `-vn` en dur dans la passe) en découlait. Ce n'était pas
> une règle du régime des enseignements qu'on aurait étendue par habitude : c'était la
> règle de la maison.
>
> **Elle cesse de l'être.** Le profil `sparks` ([ADR-0011](0011-sparks-profile-video-renditions.md))
> encode la piste vidéo, en deux rendus, avec des segments de 5 s. La frontière que
> l'amendement du 2026-08-12 annonçait « actuelle, pas définitive » tombe donc ici, et
> elle tombe comme il l'avait prévu : **dans l'échelle de rendus**, sans URL jumelle —
> `master.m3u8` porte les variantes vidéo, et `outputPlaylist` ne change ni de nom ni de
> forme.
>
> **Ce que cet ADR garde, et qui n'est pas peu.** La règle survit **telle quelle** comme
> règle des profils `teaching` et `radio` : les deux passent toujours `-vn`, le FLAC reste
> l'audio extrait sans perte, l'échelle à trois barreaux ne bouge pas d'un kilobit. Rien
> du fonds déjà transcodé ne change, et aucun consommateur existant ne voit un champ de
> plus.
>
> **La bonne lecture, désormais** : *c'est le profil qui dit si la vidéo est jetée*, comme
> c'est déjà lui qui dit où se lit la sortie ([ADR-0010](0010-radio-profile-loudness-normalisation.md))
> et combien de temps dure un segment. « Ce service est audio » devient « ce service a un
> profil audio par défaut » — et la phrase à ne plus écrire est « une vidéo est un simple
> conteneur », qui n'est vraie que de deux profils sur trois.

## Consequences

- Un fichier vidéo **sans piste audio** est un échec métier légitime (voir cycle de vie
  FAILED), détecté par `ffprobe` dans le worker, pas à l'upload. **Vrai sur les trois
  profils** : un Spark muet n'en est pas un, et l'ADR-0011 n'a pas rouvert cette garde.
- L'artefact d'archive n'est pas la vidéo mais l'audio extrait sans perte (voir ADR-0004).
  Les profils `radio` et `sparks` n'en produisent aucun.
- **La sonde dit aussi s'il y a une image** (`hasVideo`), depuis l'ADR-0011 — et elle
  écarte les **jaquettes embarquées**, qui sont des flux vidéo au sens de ffprobe et des
  diaporamas d'une image au sens de l'encodeur.
