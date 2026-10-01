import Transcode from '#transcodes/models/transcode'
import { FfmpegTranscoder } from '#transcodes/services/ffmpeg_transcoder'
import { ProgressStore } from '#transcodes/services/progress_store'
import { TranscodePublisher } from '#transcodes/services/transcode_publisher'
import { RustfsStorage } from '#transcodes/services/rustfs_storage'
import { SourceStaging } from '#transcodes/services/source_staging'
import { WebhookQueue } from '#transcodes/queues/webhook_queue'
import { ArchiveQueue } from '#transcodes/queues/archive_queue'
import { NoAudioTrackException } from '#transcodes/exceptions/no_audio_track_exception'
import {
  downloadKeyPrefix,
  downloadOutputDir,
  downloadRenditionUrl,
  hlsKeyPrefix,
  hlsOutputDir,
  masterPlaylistPath,
  outputPlaylistUrl,
  radioKeyPrefix,
  radioOutputDir,
  radioTrackPath,
  radioTrackUrl,
  sparksPosterPath,
  sparksPosterUrl,
} from '#transcodes/support/hls'
import type { DownloadRenditionInfo, RadioTrackInfo, SparkMedia } from '#transcodes/support/hls'
import { NO_TAGS } from '#transcodes/support/media_tags'
import { DEFAULT_PROFILE } from '#transcodes/support/transcode_enums'
import type { TranscodeProfile } from '#transcodes/support/transcode_enums'
import { PhaseTimings } from '#transcodes/support/phase_timing'
import { inject } from '@adonisjs/core'
import { existsSync } from 'node:fs'

export interface ProcessTranscodeParams {
  id: string
  /** ffmpeg input: a local Source path (upload) or a remote URL (URL ingestion). */
  source: string
  /** true = URL source: ffmpeg reads the URL, no FLAC archive is produced. */
  remote: boolean
  /**
   * Le profil de sortie (issue #46). Absent = `teaching`, le régime historique —
   * un job déjà en file au moment d'une bascule ne porte pas ce champ.
   */
  profile?: TranscodeProfile
}

/**
 * The outcome of a completed pass, returned so the caller wires nothing by hand:
 * the playlist URL plus the three download renditions — each carrying its
 * absolute public URL and byte size (`DownloadRenditionInfo`, ADR-0009), the
 * same shape persisted on the row and pushed in the completion webhook.
 *
 * Sur le profil `radio`, il n'y a ni playlist ni échelle : `outputPlaylist` vaut
 * `null`, `downloads` est vide, et c'est `radioTrack` qui porte la sortie.
 */
export interface ProcessTranscodeResult {
  id: string
  outputPlaylist: string | null
  downloads: DownloadRenditionInfo[]
  radioTrack?: RadioTrackInfo
  /**
   * Sur le profil `sparks`, `outputPlaylist` est bien rempli — c'est un vrai jeu
   * HLS — et `sparkMedia` porte ce que la playlist ne sait pas dire : la vignette,
   * la forme d'onde, le niveau et les étiquettes.
   */
  sparkMedia?: SparkMedia
}

/**
 * Drives one Transcode from PENDING to COMPLETED (see CONTEXT.md, ADR-0004).
 *
 * The only layer that touches the model, and the single place the lifecycle
 * transitions live. Steps: probe (reject a source with no audio as a permanent
 * failure), mark PROCESSING, run the single ffmpeg pass while streaming the
 * percentage to Redis, then mark COMPLETED with the playlist URL and duration.
 *
 * COMPLETED means **"servable from RustFS"** (ADR-0004, Q18): the local HLS is
 * pushed to RustFS before the transition, and only then is the row marked done.
 * Idempotent with a checkpoint — on a retry where the HLS is already on disk it
 * skips ffmpeg and just re-pushes and finalizes, so a RustFS hiccup never
 * re-spends the CPU. Archiving the FLAC and reclaiming local disk is the
 * separate second job (ArchiveTranscode), enqueued once COMPLETED.
 *
 * ## Deux profils, un seul cycle de vie
 *
 * Le profil (issue #46) décide de **ce qui est encodé et de ce qui est publié**,
 * jamais du reste : mêmes états, même progression, même point de reprise, même
 * webhook, même reprise. Trois endroits seulement se dédoublent — le fichier que
 * le point de reprise interroge, la passe d'encodage, et les colonnes écrites à
 * `COMPLETED`.
 *
 * Tenir les deux régimes dans une même méthode est un choix : les séparer en
 * deux actions aurait recopié la sonde, le rapatriement, la transition et le
 * webhook, et c'est exactement le genre de duplication où un correctif n'est
 * appliqué qu'une fois sur deux.
 */
@inject()
export class ProcessTranscode {
  constructor(
    private transcoder: FfmpegTranscoder,
    private progressStore: ProgressStore,
    private publisher: TranscodePublisher,
    private webhookQueue: WebhookQueue,
    private rustfs: RustfsStorage,
    private archiveQueue: ArchiveQueue,
    private staging: SourceStaging
  ) {}

  async execute(params: ProcessTranscodeParams): Promise<ProcessTranscodeResult> {
    const transcode = await Transcode.findOrFail(params.id)
    const profile = params.profile ?? DEFAULT_PROFILE
    const radio = profile === 'radio'
    const sparks = profile === 'sparks'

    // Quatre étapes de natures très différentes — une sonde, un encodage, deux
    // envois réseau qui font un aller-retour **par fichier** — et rien ne disait
    // laquelle durait. Voir `PhaseTimings` : on mesure avant d'optimiser.
    const timings = new PhaseTimings()

    let downloads: { name: string; bytes: number }[] = []
    // Ce que la ligne sait déjà : sur une reprise, le niveau et les étiquettes
    // n'y sont pas par hasard (voir plus bas pourquoi ils sont écrits tôt).
    let radioTrack: RadioTrackInfo | null = transcode.radioTrack ?? null
    // Idem pour un Spark : le niveau, la forme d'onde et les étiquettes ont été
    // posés sur la ligne avant l'envoi, précisément pour survivre à une reprise.
    let sparkMedia: SparkMedia | null = transcode.sparkMedia ?? null

    // **Le point de reprise interroge le fichier que la passe écrit en dernier** :
    // `master.m3u8` pour un enseignement, la piste pour une radio. Un profil qui
    // aurait regardé le fichier de l'autre aurait ré-encodé à chaque tentative.
    const alreadyEncoded = existsSync(
      radio ? radioTrackPath(params.id) : masterPlaylistPath(params.id)
    )

    if (!alreadyEncoded) {
      const probe = await timings.time('probe', () => this.transcoder.probe(params.source))
      if (!probe.hasAudio) {
        throw new NoAudioTrackException()
      }

      /*
       * **La source distante est rapatriée avant d'être encodée**, et les deux
       * étapes sont chronométrées à part.
       *
       * ffmpeg lit très bien une URL — il la lit *pendant* l'encodage, et les
       * deux durées se confondaient alors dans un seul chiffre. Mesuré en
       * production : 5,7× le temps réel, là où la même échelle encodée depuis un
       * fichier local en fait 55 sur une machine comparable. Un dépôt pesant
       * jusqu'à 2 Go, son seul transfert peut valoir mille secondes.
       *
       * ⚠️ **Le régime d'ingestion ne bouge pas** : `params.remote` reste vrai,
       * et il n'y a donc toujours pas d'archive FLAC. Le master vit dans RustFS
       * (ADR-0007, et l'ADR-0033 du portail) ; laisser une copie de travail
       * passer pour un téléversement produirait une archive que personne n'a
       * demandée, et pour laquelle il n'y a pas de place.
       *
       * Sur le profil `radio`, cette copie locale paie un second service : la
       * normalisation lit la source **deux fois** (mesurer, puis appliquer), et
       * c'est parce qu'elle est déjà sur le disque que la seconde lecture ne
       * repasse pas par le réseau.
       */
      let input = params.source
      if (params.remote) {
        await timings.bytes('download', async () => {
          const staged = await this.staging.fetch(params.source, params.id)
          input = staged.path
          return staged.bytes
        })
      }

      transcode.status = 'PROCESSING'
      transcode.durationSeconds = probe.durationSeconds
      await transcode.save()
      await this.progressStore.set(params.id, 0)
      this.publisher.broadcast(transcode, 0)

      let lastPercent = 0
      const onProgress = (percent: number) => {
        if (percent > lastPercent) {
          lastPercent = percent
          // Best-effort: a Redis hiccup must not fail the encode.
          void this.progressStore.set(params.id, percent).catch(() => {})
          this.publisher.broadcast(transcode, percent)
        }
      }

      try {
        if (radio) {
          /*
           * **Mesurer, puis appliquer** — les deux passes de `loudnorm`, et
           * elles sont chronométrées séparément **exprès**.
           *
           * Le dépôt n'accepte une double décodification qu'avec un chiffre à
           * l'appui (l'archive FLAC). Ce chiffre-ci n'existe pas encore : cette
           * tranche a été écrite sans exécuter ffmpeg. `analyseLoudness` est donc
           * posé comme une phase à part pour que le premier titre encodé en
           * production le donne de lui-même, dans la ligne de journal, à côté de
           * `encode`. Voir `FfmpegTranscoder.measureLoudness` pour ce que le
           * second décodage achète : un gain **constant** au lieu d'un gain qui
           * varie au fil du morceau.
           */
          const measured = await timings.time('analyseLoudness', () =>
            this.transcoder.measureLoudness(input)
          )
          const encoded = await timings.time('encode', () =>
            this.transcoder.encodeRadio(
              input,
              params.id,
              measured,
              probe.durationSeconds,
              onProgress
            )
          )

          radioTrack = {
            url: radioTrackUrl(params.id),
            bytes: encoded.bytes,
            durationSeconds: probe.durationSeconds,
            loudness: encoded.loudness,
            // Les étiquettes viennent de la **source**, pas de ce qu'on a
            // produit : c'est ce que l'administrateur reconnaîtra du fichier
            // qu'il a déposé.
            tags: probe.tags,
          }

          /*
           * ⚠️ **Persisté ici, avant l'envoi — et c'est la seule colonne de ce
           * service qui l'est.**
           *
           * Le niveau et les étiquettes sont des sous-produits d'une passe que
           * le point de reprise ne rejouera pas : les étiquettes vivaient sur la
           * source, que le `finally` juste en dessous rend à l'appelant, et le
           * niveau de sortie n'existe que dans la sortie d'erreur de ffmpeg. Les
           * garder en mémoire jusqu'à `COMPLETED` les perdrait au premier hoquet
           * de RustFS — la tentative suivante trouverait la piste sur le disque,
           * sauterait l'encodage (ce qu'on veut) et publierait un webhook sans
           * niveau ni étiquettes (ce qu'on ne veut pas).
           *
           * L'URL y est donc écrite avant que les octets soient servables. Ce
           * n'est pas visible du dehors : les trois canaux ne publient
           * `radioTrack` qu'à `COMPLETED` — c'est `TranscodeTransformer` qui tient
           * cette garde, et c'est là qu'elle est expliquée.
           */
          transcode.radioTrack = radioTrack
          await transcode.save()
        } else if (sparks) {
          /*
           * **Le même double décodage que la radio, pour la même raison**, et un
           * sous-produit de plus : la passe d'analyse rend la mesure de niveau
           * *et* la forme d'onde, d'une seule lecture (voir
           * `FfmpegTranscoder.analyseSparks`). La durée et les étiquettes, elles,
           * sortent de l'en-tête du conteneur sans décoder un échantillon.
           */
          const analysis = await timings.time('analyseLoudness', () =>
            this.transcoder.analyseSparks(input)
          )
          const loudness = await timings.time('encode', () =>
            this.transcoder.encodeSparks(
              input,
              params.id,
              analysis.measured,
              probe.hasVideo,
              probe.durationSeconds,
              onProgress
            )
          )

          /*
           * La vignette est tirée **après** l'encodage et **avant** l'envoi, parce
           * qu'elle part dans le dossier HLS : écrite plus tard, elle aurait raté
           * le `uploadDirectory` et il aurait fallu un second envoi, une seconde
           * clé, une seconde chance de se tromper.
           *
           * Elle n'est tirée que s'il y a une image : un Spark sonore n'a pas de
           * poster, et `null` dit cela mieux qu'un carré noir.
           */
          const poster = probe.hasVideo
            ? await timings.time('poster', () =>
                this.transcoder.extractPoster(input, params.id, probe.durationSeconds)
              )
            : false

          sparkMedia = {
            playlist: outputPlaylistUrl(params.id),
            poster: poster ? sparksPosterUrl(params.id) : null,
            hasVideo: probe.hasVideo,
            durationSeconds: probe.durationSeconds,
            waveform: analysis.waveform,
            loudness,
            // Les étiquettes viennent de la **source**, comme pour la radio.
            tags: probe.tags,
          }

          /*
           * ⚠️ **Persisté avant l'envoi**, exactement pour la raison de
           * `radio_track` : le niveau de sortie n'existe que dans la sortie
           * d'erreur de ffmpeg, la forme d'onde que dans le tuyau de la passe
           * d'analyse, et les étiquettes que sur une source que le `finally`
           * rend juste en dessous. Un hoquet de RustFS ici, et la tentative
           * suivante trouverait le `master.m3u8` sur le disque, sauterait
           * l'encodage — ce qu'on veut — et publierait un Spark sans forme d'onde
           * ni niveau.
           */
          transcode.sparkMedia = sparkMedia
          await transcode.save()
        } else {
          const result = await timings.time('encode', () =>
            this.transcoder.encode(input, params.id, probe.durationSeconds, onProgress)
          )
          downloads = result.downloads
        }
      } finally {
        // **Réussi ou non.** Une copie de travail abandonnée sur le disque ne se
        // rattrape par aucun nettoyage : rien ne la référence, et le job
        // d'archivage d'une ingestion par URL ne la connaît pas.
        if (params.remote) await this.staging.discard(params.id)
      }
    } else if (radio) {
      // Checkpoint retry, profil radio : la **taille** se relit sur le fichier,
      // le **niveau** et les **étiquettes** se relisent sur la ligne — ils y ont
      // été posés avant l'envoi précisément parce qu'ils ne se retrouvent pas.
      const bytes = await this.transcoder.measureRadioTrack(params.id)
      radioTrack = {
        url: radioTrackUrl(params.id),
        bytes,
        // La durée se relit sur la **ligne** : la sonde ne tourne pas sur une
        // reprise, et `duration_seconds` y a été persisté au passage en
        // `PROCESSING` précisément parce qu'il ne se retrouve pas autrement.
        durationSeconds: transcode.durationSeconds ?? radioTrack?.durationSeconds ?? null,
        loudness: radioTrack?.loudness ?? null,
        tags: radioTrack?.tags ?? NO_TAGS,
      }
    } else if (sparks) {
      /*
       * Reprise après point de reprise, profil `sparks` : **tout se relit sur la
       * ligne**, rien sur le disque.
       *
       * Il n'y a aucune taille à remesurer — un jeu HLS est un arbre, pas un
       * fichier — et les trois sous-produits de la passe d'analyse ne se
       * retrouvent nulle part ailleurs. C'est pourquoi ils y ont été posés avant
       * l'envoi. Si la ligne ne les porte pas (une reprise qui traverse une
       * version antérieure), on republie au moins ce qui est déterministe : la
       * playlist et la vignette, qui se déduisent de l'identifiant.
       */
      sparkMedia = sparkMedia ?? {
        playlist: outputPlaylistUrl(params.id),
        poster: existsSync(sparksPosterPath(params.id)) ? sparksPosterUrl(params.id) : null,
        hasVideo: transcode.sourceKind === 'video',
        durationSeconds: transcode.durationSeconds ?? null,
        waveform: null,
        loudness: null,
        tags: NO_TAGS,
      }
    } else {
      // Checkpoint retry: the pass already staged the `.aac` alongside the HLS —
      // recover their sizes without re-encoding (ADR-0009).
      downloads = await this.transcoder.measureDownloads(params.id)
    }

    // Push the HLS *and* the download renditions to RustFS *before* COMPLETED —
    // the client must be able to play/download from the serving origin the moment
    // we say it's ready (Q18). The `.aac` ride their own `dl/<id>/` prefix.
    //
    // Une radio n'a qu'un fichier, mais il part par `uploadDirectory` comme les
    // autres : c'est le dossier entier qui est poussé sous un préfixe, et la
    // reprise efface ce même préfixe. Un `uploadFile` aurait nommé la clé une
    // seconde fois, ailleurs.
    if (radio) {
      await timings.count('uploadRadio', () =>
        this.rustfs.uploadDirectory(radioOutputDir(params.id), radioKeyPrefix(params.id))
      )
    } else {
      // Un Spark passe par ici aussi : son jeu HLS vit sous le **même** préfixe
      // public que celui d'un enseignement, et sa vignette voyage dedans. C'est ce
      // qui lui épargne un bloc Caddy, une politique de préfixe et une branche de
      // reprise — trois endroits où un oubli rend 403 ou 404 sans dire pourquoi.
      await timings.count('uploadHls', () =>
        this.rustfs.uploadDirectory(hlsOutputDir(params.id), hlsKeyPrefix(params.id))
      )
      // Les rendus progressifs n'existent que sur le régime historique (ADR-0009).
      if (!sparks) {
        await timings.count('uploadDownloads', () =>
          this.rustfs.uploadDirectory(downloadOutputDir(params.id), downloadKeyPrefix(params.id))
        )
      }
    }

    // Pair each measured byte size with its absolute public URL — the single
    // shape the row, the webhook and the returned result all carry (ADR-0009).
    const renditions: DownloadRenditionInfo[] = downloads.map((rendition) => ({
      name: rendition.name,
      url: downloadRenditionUrl(params.id, rendition.name),
      bytes: rendition.bytes,
    }))

    transcode.status = 'COMPLETED'
    if (!radio) {
      transcode.outputPlaylist = outputPlaylistUrl(params.id)
    }
    if (profile === 'teaching') {
      // Persist the download renditions alongside the playlist so the row is
      // self-describing — the client (#187) gets URLs + sizes without a HEAD.
      //
      // ⚠️ Seulement sur le régime historique : un Spark n'a pas de rendus
      // progressifs, et lui écrire un tableau vide ferait dire à la colonne « on a
      // cherché et il n'y en a pas » là où la vérité est « ce profil n'en produit
      // pas ». La nuance se paie à la lecture, pas à l'écriture.
      transcode.downloads = renditions
    }
    // Sur le profil radio, `output_playlist` reste `null` : **il n'y a pas de
    // playlist**. Y ranger l'URL du fichier ferait mentir le nom de la colonne,
    // et le dépôt a déjà payé ce genre de mensonge une fois.
    await transcode.save()
    await this.progressStore.set(params.id, 100)
    this.publisher.broadcast(transcode, 100)

    // Completion webhook (jalon I): notify the caller URL, if any, of the
    // terminal COMPLETED state via a dedicated retrying delivery job.
    if (transcode.callbackUrl) {
      await this.webhookQueue.enqueue({
        transcodeId: transcode.id,
        callbackUrl: transcode.callbackUrl,
        callbackSecret: transcode.callbackSecret ?? undefined,
        payload: {
          id: transcode.id,
          status: transcode.status,
          progress: 100,
          outputPlaylist: transcode.outputPlaylist ?? null,
          error: null,
          // ADR-0009: the completion payload carries the duration and, per
          // rendition, the download URL + byte size — so the consumer (#187)
          // persists and serves them without a HEAD per file.
          durationSeconds: transcode.durationSeconds,
          downloads: renditions,
          // ⚠️ **Ajouté seulement sur le profil radio.** La charge utile d'un
          // enseignement doit rester au champ près celle que le portail reçoit
          // aujourd'hui ; un champ de plus, même vide, serait un changement de
          // contrat pour un consommateur qui n'a rien demandé.
          ...(radio && radioTrack ? { radioTrack } : {}),
          ...(sparks && sparkMedia ? { sparkMedia } : {}),
        },
      })
    }

    // Second stage (ADR-0004): archive the FLAC (uploads only) and reclaim local
    // disk. A separate job so a RustFS outage retries without re-encoding.
    await this.archiveQueue.enqueue({
      id: params.id,
      source: params.source,
      remote: params.remote,
      // Le profil suit : une radio n'a **jamais** d'archive FLAC, même déposée
      // par téléversement, et ce job est le seul qui puisse encore en produire.
      profile,
    })

    // **La mesure est posée ici et pas plus tôt** : après l'archive mise en file,
    // avant le retour. Plus haut, elle raterait la fin ; dans un `finally`, elle
    // sortirait aussi sur un échec — et une ligne « terminé » sur un transcodage
    // qui a échoué est exactement le genre de journal qui trompe à 3 h du matin.
    timings.log(params.id, {
      // **Ce qui rend la ligne lisible sans arithmétique.** Sans la durée de
      // l'audio, « encode : 1006 s » ne dit pas si c'est rapide ou lent ; avec
      // elle, le rapport au temps réel saute aux yeux.
      //
      // ⚠️ `regime` dit **par où ffmpeg a lu**, pas comment l'enseignement a été
      // déposé : un fichier téléversé au portail arrive ici en `url`, parce que
      // le portail le range dans RustFS et nous en remet une URL présignée. Voir
      // `LogContext.regime` — la confusion a déjà fait chercher une mesure qui ne
      // peut pas exister.
      audioSeconds: transcode.durationSeconds,
      regime: params.remote ? 'url' : 'fichier',
      ffmpeg: await this.transcoder.version(),
      // **Seulement quand ce n'est pas le régime historique.** La ligne des
      // enseignements est citée telle quelle dans le README ; lui ajouter un
      // champ obligerait à la réécrire pour un profil qu'elle ne décrit pas.
      profile: profile === DEFAULT_PROFILE ? undefined : profile,
    })

    // The download renditions are now on the public origin: hand the caller (#186)
    // each rendition's absolute URL + byte size so it can persist and publish them.
    return {
      id: params.id,
      outputPlaylist: transcode.outputPlaylist ?? null,
      downloads: renditions,
      ...(radioTrack ? { radioTrack } : {}),
      ...(sparkMedia ? { sparkMedia } : {}),
    }
  }
}
