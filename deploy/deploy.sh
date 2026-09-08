#!/usr/bin/env bash
# ==============================================================================
# Déploiement blue/green du service de streaming — s'exécute sur le VPS.
#
#   ./deploy.sh <image>     déploie l'image sur la couleur inactive puis bascule
#   ./deploy.sh rollback    rebascule sur la couleur précédente (toujours en place)
#   ./deploy.sh status      affiche l'état courant
#
# Une couleur, ici, ce sont DEUX conteneurs : le serveur HTTP et son worker de
# transcodage. Le serveur décide de la bascule (c'est lui que Caddy vise et lui
# seul qui expose `/health`) ; le worker le suit pour que le code qui encode soit
# toujours celui de l'API qui a accepté le fichier.
#
# Faire tourner brièvement les deux workers est sans danger : BullMQ verrouille
# chaque job sur un seul consommateur.
#
# La bascule est un `caddy reload` : la configuration est rechargée sans fermer
# l'écoute ni couper les connexions en cours, et sans aucun droit root — `caddy
# reload` dialogue avec l'API d'administration sur 127.0.0.1:2019.
# ==============================================================================
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/opt/eenv-stream}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
UPSTREAM_FILE="${UPSTREAM_FILE:-/etc/caddy/eenv-stream-upstream.caddy}"
STATE_FILE="$ROOT_DIR/active_color"

# Durée pendant laquelle l'ANCIEN SERVEUR continue de tourner après la bascule,
# le temps que s'achèvent les requêtes et les flux SSE déjà ouverts. Doit rester
# <= au `stop_grace_period` des serveurs (150 s).
DRAIN_SECONDS="${DRAIN_SECONDS:-120}"

# Le service démarre vite (pas d'assets à charger) ; son HEALTHCHECK annonce
# `start-period=45s`.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"

port_for() {
  case "$1" in
    blue)  echo 3002 ;;
    green) echo 3003 ;;
    *)     return 1 ;;
  esac
}

cd "$ROOT_DIR"

log()    { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()     { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

active_color() { cat "$STATE_FILE" 2>/dev/null || echo ''; }

target_color() {
  case "$(active_color)" in
    blue) echo green ;;
    *)    echo blue ;;
  esac
}

# Seul le SERVEUR porte la sonde : le worker n'écoute sur aucun port, sa santé se
# lit à ce qu'il consomme la file, pas à une réponse HTTP.
wait_healthy() {
  local color="$1" port deadline=$((SECONDS + HEALTH_TIMEOUT)) state
  port="$(port_for "$color")"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$(docker inspect -f '{{.State.Health.Status}}' "eenv-stream-$color" 2>/dev/null || echo absent)"
    if [ "$state" = 'healthy' ] && curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; then
      return 0
    fi
    if [ "$state" = 'absent' ]; then
      return 1
    fi
    sleep 3
  done
  return 1
}

# Le worker doit tourner : un conteneur arrêté ou en boucle de redémarrage vide
# la file sans rien encoder, et personne ne s'en aperçoit avant qu'un dépôt reste
# indéfiniment « en cours ».
worker_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "eenv-stream-worker-$1" 2>/dev/null || echo false)" = 'true' ]
}

# Réécrit l'unique ligne importée par le bloc du site, valide la configuration
# COMPLÈTE du VPS (d'autres sites y tournent), puis recharge. Configuration
# invalide = restauration immédiate : Caddy n'a jamais vu l'erreur.
switch_traffic() {
  local color="$1" previous
  previous="$(cat "$UPSTREAM_FILE" 2>/dev/null || echo '')"

  printf 'reverse_proxy 127.0.0.1:%s\n' "$(port_for "$color")" > "$UPSTREAM_FILE"

  if ! caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null 2>&1; then
    printf '%s' "$previous" > "$UPSTREAM_FILE"
    fail "Configuration Caddy invalide — bascule annulée"
    return 1
  fi

  caddy reload --adapter caddyfile --config "$CADDYFILE"
  echo "$color" > "$STATE_FILE"
}

deploy() {
  local image="$1" target previous
  target="$(target_color)"
  previous="$(active_color)"

  log "Image        : $image"
  log "Couleur      : ${previous:-aucune} → $target"

  log 'Récupération de l’image'
  docker pull "$image"

  [ -f "$ROOT_DIR/.env" ] && cp "$ROOT_DIR/.env" "$ROOT_DIR/.env.previous"
  printf 'STREAM_IMAGE=%s\n' "$image" > "$ROOT_DIR/.env"

  log 'Migrations'
  docker compose run --rm migrations

  log "Démarrage de $target (serveur + worker)"
  docker compose up -d --force-recreate "$target" "worker-$target"

  log "Attente de /health sur $target (${HEALTH_TIMEOUT}s max)"
  if ! wait_healthy "$target"; then
    fail "$target n’est pas saine — AUCUNE bascule, ${previous:-aucune couleur} continue de servir"
    docker compose logs --tail 60 "$target" >&2 || true
    curl -sS "http://127.0.0.1:$(port_for "$target")/health" >&2 || true
    docker compose stop "$target" "worker-$target" >/dev/null 2>&1 || true
    [ -f "$ROOT_DIR/.env.previous" ] && mv "$ROOT_DIR/.env.previous" "$ROOT_DIR/.env"
    exit 1
  fi
  ok "$target est saine"

  # Le serveur peut être sain alors que le worker s'est écroulé au démarrage :
  # ils ne partagent que l'image, pas le sort. Basculer sans worker donnerait un
  # service qui accepte les fichiers et n'en encode aucun.
  if ! worker_running "$target"; then
    fail "Le worker $target ne tourne pas — AUCUNE bascule"
    docker compose logs --tail 60 "worker-$target" >&2 || true
    docker compose stop "$target" "worker-$target" >/dev/null 2>&1 || true
    [ -f "$ROOT_DIR/.env.previous" ] && mv "$ROOT_DIR/.env.previous" "$ROOT_DIR/.env"
    exit 1
  fi
  ok "Le worker $target consomme la file"

  log "Bascule du trafic vers $target"
  switch_traffic "$target"
  ok "Caddy sert désormais $target"

  if [ -n "$previous" ] && [ "$previous" != "$target" ]; then
    log "Drain de $previous (${DRAIN_SECONDS}s) — requêtes et flux SSE en cours"
    sleep "$DRAIN_SECONDS"

    docker compose stop "$previous"
    ok "Serveur $previous arrêté"

    # L'ancien worker, lui, ne s'arrête qu'une fois son transcodage terminé
    # (`worker.close()` attend le job en cours). Jusqu'à dix minutes — pendant
    # lesquelles le site n'est PAS coupé : seul ce script patiente.
    warn "Arrêt du worker $previous — jusqu’à 10 min si un transcodage tourne"
    docker compose stop "worker-$previous"
    ok "Worker $previous arrêté"
  fi

  docker image prune -f >/dev/null 2>&1 || true
  ok "Déploiement terminé"
}

# Les conteneurs de l'ancienne couleur sont seulement *arrêtés*, jamais
# supprimés : ils portent encore leur image précédente. Le rollback les redémarre
# tels quels — sans rien retélécharger — et rebascule Caddy.
rollback() {
  local target abandoned
  target="$(target_color)"
  abandoned="$(active_color)"

  if ! docker inspect "eenv-stream-$target" >/dev/null 2>&1; then
    fail "Aucun conteneur eenv-stream-$target à rollback (premier déploiement ?)"
    exit 1
  fi

  log "Redémarrage de $target (serveur + worker)"
  docker start "eenv-stream-$target" >/dev/null
  docker start "eenv-stream-worker-$target" >/dev/null 2>&1 || \
    warn "Worker $target absent — le service acceptera des fichiers sans les encoder"

  if ! wait_healthy "$target"; then
    fail "$target ne redevient pas saine — rollback impossible"
    docker logs --tail 60 "eenv-stream-$target" >&2 || true
    exit 1
  fi

  switch_traffic "$target"

  printf 'STREAM_IMAGE=%s\n' "$(docker inspect -f '{{.Config.Image}}' "eenv-stream-$target")" > "$ROOT_DIR/.env"

  if [ -n "$abandoned" ] && [ "$abandoned" != "$target" ]; then
    docker compose stop "$abandoned" >/dev/null 2>&1 || true
    warn "Arrêt du worker $abandoned — jusqu’à 10 min si un transcodage tourne"
    docker compose stop "worker-$abandoned" >/dev/null 2>&1 || true
  fi

  ok "Rollback effectué — Caddy sert $target"
  printf '\033[1;33m! Les migrations jouées entre-temps ne sont PAS annulées.\033[0m\n'
}

show_status() {
  local current; current="$(active_color)"
  printf 'Couleur active : %s\n' "${current:-aucune}"
  printf 'Image          : %s\n' "$(grep -h '^STREAM_IMAGE=' "$ROOT_DIR/.env" 2>/dev/null | cut -d= -f2- || echo inconnue)"
  printf 'Caddy pointe   : %s\n' "$(cat "$UPSTREAM_FILE" 2>/dev/null || echo 'non configuré')"
  echo
  docker compose ps -a --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  echo
  for color in blue green; do
    printf '%-6s /health → %s\n' "$color" \
      "$(curl -fsS "http://127.0.0.1:$(port_for "$color")/health" 2>/dev/null || echo 'injoignable')"
    printf '%-6s worker  → %s\n' "$color" \
      "$(worker_running "$color" && echo 'en marche' || echo 'arrêté')"
  done
}

case "${1:-}" in
  rollback) rollback ;;
  status)   show_status ;;
  '')       fail "Usage : $0 <image> | rollback | status"; exit 1 ;;
  *)        deploy "$1" ;;
esac
