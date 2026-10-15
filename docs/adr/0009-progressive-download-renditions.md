# Progressive download renditions ride the HLS pipeline

> **Amendement du 2026-10-15 — spike #184 mesuré en production, voir [ADR-0012](0012-reprise-par-plage-ce-que-l-origine-tient-vraiment.md).**
> Le dernier point des conséquences ci-dessous énonçait deux risques restants : l'un n'existe pas,
> l'autre s'est réalisé. **Il n'y a aucun CDN devant Caddy** (même enregistrement A pour les trois
> hôtes, `via: 1.1 Caddy`, aucun en-tête de bord) : le risque « un CDN avale le `Range` » est sans
> objet aujourd'hui. En revanche **RustFS ignore `If-Range`** — validateur fort comme date : il
> renvoie `206` au lieu de `200` sur un validateur périmé, alors qu'il honore `If-None-Match`
> (`304`) et `If-Match` (`412`). Le reste tient : `206`, `Content-Range`, `Accept-Ranges`, `416`,
> `ETag` stable, et un recollage `sha256`-identique au fichier entier. La protection de la reprise
> est donc **côté client** : comparer l'`ETag` que porte le `206`, pas armer `If-Range`.

The service already produces three **HLS** renditions (64/128/192 kbps AAC-LC, ADR-0001) from a
single `ffmpeg` pass. It will now emit, **from that same pass**, three **progressive** single-file
renditions meant for **offline download** by the mobile client — one file per quality, same bitrate
ladder.

```text
hls/<id>/{low,mid,high}/index.m3u8   (+ seg_*.ts)   ← streaming, unchanged
dl/<id>/{low,mid,high}.aac                            ← download, new
archives/<id>.flac                                    ← archive, unchanged (upload path only)
```

## Why a separate file and not the HLS

HLS is a playlist plus hundreds of segments — an *tree*, not a *file*. Downloading it offline means
fetching every segment and rewriting the manifest locally, and **resuming** it means bookkeeping per
segment. A single progressive file resumes with one HTTP `Range` request and plays its
already-downloaded prefix natively. The download feature is a client concern, but the **shape of
what it downloads is decided here**, because only this service holds the encoder.

## Why AAC in an ADTS container, not `.m4a`/MP4

The client must play a **half-downloaded** file (listen to what has arrived while the rest is still
coming). An MP4/`.m4a` places its `moov` index at the **end** by default, so a file downloaded from
the front is unplayable until complete; `+faststart` moves it, but partial playback then depends on
each OS player tolerating a truncated MP4. **ADTS** (`-f adts`) is frame-concatenated like MP3: no
central index, so any prefix is valid audio and plays to wherever the bytes stop. The ffmpeg native
AAC encoder is effectively **ABR** (`-b:a` targets an average via a bit reservoir; measured per-frame
spread ≈30 % at 128 kbps), so without a container index seeking is estimated as `time × bitrate` —
approximate (~1 % duration drift) but adequate, and players resync on ADTS frame sync words. It is
**not** byte-exact CBR (true CBR only holds for the MP3 fallback). On Android, enable ExoPlayer's
`FLAG_ENABLE_CONSTANT_BITRATE_SEEKING`. AAC over MP3 for efficiency at 64 kbps, which is the floor
for worship audio (ADR-0001 rationale).

> **Fallback — spike #183 resolved: ADTS holds (at the container/decoder level).** A harness
> (ffmpeg 9.0) confirmed a 40 %-truncated ADTS `.aac` decodes cleanly from 0 to the cut, with a
> single incomplete tail frame (a clean stop), and — crucially — reports a duration equal to the
> *downloaded* portion (no `moov`, duration estimated from byte size), so the seek bar stays honest
> and reaching the end reads as end-of-track. **One check still pending on device**: iOS/AVPlayer
> with a raw `file://` ADTS stream (the sole plausible failure that would force the fallback).
> MP3 remains the fallback **only** if that device check fails — and **if MP3 is ever adopted, its
> download renditions MUST be encoded with `-write_xing 0`**: LAME's default Xing/Info header
> advertises the *full* original duration in a truncated file, so a player believes a 48 s prefix is
> 120 s and stalls instead of stopping (breaks partial-playback UX). ADTS has no such header by
> design. Otherwise nothing else in this ADR changes — same ladder, same `dl/<id>/` layout, same
> webhook fields; only the codec/extension move.

## The pass produces four *kinds* of output now

`buildArgs()` (`app/transcodes/support/hls.ts`, `services/ffmpeg_transcoder.ts`) gains three mapped
outputs — `-map 0:a:0 -c:a aac -b:a <ladder> -f adts dl/<v>.aac` — beside the HLS variant map. One
source read, no second decode. The encoder measures each `.aac`'s **byte size** locally (before
upload) and reports it: the caller needs exact sizes for the client's progress bar, resume
validation and disk pre-check (see caller ADR-0038), and a `HEAD` round-trip per file is the thing
we are avoiding.

## Versioned, stable, public keys

The `.aac` live under `dl/<transcodeId>/` on the **same RustFS + Caddy public origin** as the HLS
(ADR-0004, ADR-0006 — the published URL is absolute). The `<transcodeId>` in the path makes every
re-transcode a **new URL**: a download paused for days and resumed with `Range` can never splice
bytes from a different version, and the caller can retire the old version by letting its URL 404.
URLs are **not signed** — a signed URL would expire mid-pause and make "resume days later" fail with
a 403.

## Consequences

- **Webhook grows** (ADR-0005): the completion payload carries, per rendition, the download URL and
  byte size, alongside `outputPlaylist`. `durationSeconds` is already probed and sent.
- **`transcodes` model grows**: download URLs + byte sizes persisted (three columns per axis, or one
  JSON blob). No per-rendition *bitrate* column — the ladder stays implicit (ADR-0001).
- **Delete widens** (ADR-0008): purging a transcode now also `deletePrefix('dl/<id>/')`.
- **URL ingestion keeps its bargain** (ADR-0007): the `.aac` are derived outputs, not the source, so
  nothing about who-keeps-the-source changes. Unlike the FLAC archive, the `.aac` are produced on
  **both** ingestion paths — they are a serving artefact, not an archival one.
- **Content-type** `audio/aac` (or `audio/mpeg` on MP3 fallback) set on upload, and the origin must
  answer `Range` on these objects end to end (a caller-side prerequisite, verified before shipping).
- **Serving needs a `/dl/*` route (spike #184).** The Caddy front only routes `/hls/*` today, so
  `/dl/*` falls through to the app. A `handle /dl/*` block mirroring `/hls/*` is required, and the
  `dl/` prefix must be made anonymously readable in the bucket policy (`docker-compose.yml`
  `createbucket`) since the URLs are unsigned. Caddy's transparent `reverse_proxy` was verified to
  preserve `Range`/`206`/`Content-Range`/`ETag`/`416` and byte-exact resume — **measured end to end
  in production on 2026-10-15 (ADR-0012)**, including the absence of `encode` on the `/dl/*` block.
  The two risks this bullet used to list are settled: there is **no CDN** in front, and RustFS
  **ignores `If-Range`**, so the resume guard belongs to the client (compare the `ETag` carried by
  the `206`). If a CDN is ever added, it must forward the header, not compress `audio/aac`, and not
  cache-collapse ranges — and ADR-0012's protocol is the one to replay.
