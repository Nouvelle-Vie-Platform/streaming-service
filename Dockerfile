# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Base — Node 24 (Debian slim) + a full ffmpeg build + tini for clean signals.
# Debian's ffmpeg is a complete build (native AAC, FLAC, HLS muxer) — exactly
# what the worker needs. tini reaps zombies and forwards SIGTERM so the worker
# drains its BullMQ jobs on shutdown.
#
# ## Trixie et pas bookworm : c'est ffmpeg 7 qu'on vient chercher
#
# `bookworm` livre **ffmpeg 5.1**, `trixie` livre **7.1**. Entre les deux,
# ffmpeg 7.0 a remplacé son ordonnanceur de transcodage par une version
# **multi-fils, un fil par sortie**. Notre passe en compte six (trois rendus
# HLS, trois `.aac`), et sous 5.1 elles s'encodaient **l'une après l'autre**.
#
# Mesuré, et c'est ce qui a tranché :
#
#   • un encodage seul, dans ce conteneur   300 s d'audio en 5,47 s → ×54,8
#   • les six, en production                5089 s d'audio en 830 s → ×6,1
#   • les six, sous ffmpeg 9 (poste de dev) 300 s d'audio en 5,42 s → ×55,4
#                                           avec user 26,97 s, soit ~5 cœurs
#
# Un cœur du VPS va donc **aussi vite** que celui du poste de dev — la machine
# n'est pas en cause, et elle était à 0,8 de charge sur huit cœurs pendant la
# mesure. Ce qui manquait était le parallélisme entre sorties, et il arrive avec
# la version.
#
# Le correctif tenté avant celui-ci — un processus ffmpeg par rendu — obtenait le
# même effet en écrivant `master.m3u8` à la main, c'est-à-dire en prenant la
# responsabilité du fichier que tous les téléphones demandent en premier. Une
# ligne de `FROM` coûte moins cher.
# ---------------------------------------------------------------------------
FROM node:24-trixie-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies — install everything (dev deps are needed to build).
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Build — compile TypeScript to ./build (a self-contained deployable that
# already carries package.json + package-lock.json).
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN node ace build

# ---------------------------------------------------------------------------
# Production — the compiled app + production dependencies only, run as non-root.
# ---------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production
ENV PORT=3333
ENV HOST=0.0.0.0

COPY --from=build /app/build ./
RUN npm ci --omit=dev && npm cache clean --force

# Writable scratch for the Source and HLS staging (ephemeral — every artifact
# is deleted once it reaches RustFS, ADR-0004).
RUN mkdir -p /app/storage && chown -R node:node /app
USER node

EXPOSE 3333

# Internal probe read by `docker inspect .State.Health.Status`, which `deploy.sh` uses as its first
# green light before flipping Caddy. It hits `/health` — which actually exercises Postgres, Redis
# and RustFS — rather than `/`, which answers "It works!" from memory.
#
# Roles that are not the HTTP server (worker, migrations) override CMD and expose no port; the
# compose file disables this probe for them, since a container with no listener would otherwise be
# permanently unhealthy.
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Overridden per role in docker-compose (server / worker / migrate).
CMD ["node", "bin/server.js"]
