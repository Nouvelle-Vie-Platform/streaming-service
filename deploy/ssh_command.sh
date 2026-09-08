#!/usr/bin/env bash
# ==============================================================================
# Garde-barrière SSH de la clé GitHub Actions — service de streaming Nouvelle Vie.
#
# L'utilisateur `deploy` appartient au groupe `docker` : quiconque ouvre un shell
# avec sa clé est root sur le VPS en pratique. Et comme le même utilisateur sert
# plusieurs projets sur cette machine, la clé d'un projet pourrait déclencher le
# déploiement d'un autre.
#
# Ce script referme les deux : la clé d'Actions est déclarée dans
# `~/.ssh/authorized_keys` avec une **commande forcée** qui pointe ici. Quoi que
# le porteur de la clé demande, c'est ce script qui s'exécute — jamais un shell.
# Il n'autorise que deux gestes, et seulement sur une image de CE dépôt :
#
#   authorized_keys :
#     restrict,command="/opt/eenv-stream/ssh_command.sh" ssh-ed25519 AAAA… github-actions-eenv-stream
#
# `restrict` coupe en plus les redirections de ports, l'agent, le pty et X11.
#
# Un rollback ne passe pas par ici : c'est un geste humain, fait avec ta propre
# clé (non restreinte), en connaissance de cause.
# ==============================================================================
set -euo pipefail

DEPLOY_SCRIPT='/opt/eenv-stream/deploy.sh'

# Seules des images de ce dépôt sont déployables : une clé volée ne peut pas faire
# tourner une image arbitraire (ce qui reviendrait à exécuter du code en root).
ALLOWED_IMAGE='^ghcr\.io/nouvelle-vie-platform/streaming-service:[A-Za-z0-9._-]+$'

reject() {
  printf 'Commande refusée : %s\n' "${SSH_ORIGINAL_COMMAND:-<shell interactif>}" >&2
  exit 1
}

[ -n "${SSH_ORIGINAL_COMMAND:-}" ] || reject

# Découpage sur les espaces : une référence d'image n'en contient jamais.
# shellcheck disable=SC2086
set -- $SSH_ORIGINAL_COMMAND

[ "${1:-}" = "$DEPLOY_SCRIPT" ] || reject
[ $# -eq 2 ] || reject

case "$2" in
  status)
    exec "$DEPLOY_SCRIPT" status
    ;;
  *)
    printf '%s' "$2" | grep -qE "$ALLOWED_IMAGE" || reject
    exec "$DEPLOY_SCRIPT" "$2"
    ;;
esac
