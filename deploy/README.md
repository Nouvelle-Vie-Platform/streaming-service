# Déploiement du service de streaming

Blue/green sur le VPS Contabo, derrière un Caddy qui tourne **sur l'hôte**. PostgreSQL, Redis et
RustFS sont **externes** ; ce stack les rejoint par leurs réseaux Docker existants.

| | |
|---|---|
| Domaine | `https://stream.eenv.brainsial.com` |
| Dossier VPS | `/opt/eenv-stream/` |
| Ports (127.0.0.1) | `3002` bleu · `3003` vert |
| Image | `ghcr.io/nouvelle-vie-platform/streaming-service` |
| Bucket | `eenv-streaming` — `hls/` et `dl/` publics, `archives/` privé |

## Ce qui le distingue du portail

**Une couleur = deux conteneurs** : le serveur HTTP et son worker de transcodage. Le worker suit la
couleur, pour que le code qui encode soit toujours celui de l'API qui a accepté le fichier.

Faire tourner brièvement les deux workers est **sans danger** : BullMQ verrouille chaque job sur un
seul consommateur, ils se partagent la file sans jamais traiter le même fichier.

**Le worker met jusqu'à 10 minutes à s'arrêter** (`stop_grace_period: 600s`). À la réception de
`SIGTERM`, `transcode:work` appelle `worker.close()`, qui **attend la fin du job en cours** : un
encodage ffmpeg s'achève au lieu d'être tué au milieu et rejoué depuis le début.

> Un déploiement lancé pendant un transcodage peut donc paraître long. **Le site n'est pas coupé** —
> seul le script patiente.

## Installation (une seule fois)

```bash
sudo mkdir -p /opt/eenv-stream
sudo install -o deploy -g deploy -m 644 docker-compose.yml /opt/eenv-stream/
sudo install -o root   -g root   -m 755 deploy.sh         /opt/eenv-stream/
sudo install -o root   -g root   -m 755 ssh_command.sh   /opt/eenv-stream/

sudo install -o deploy -g deploy -m 600 app.env.example /opt/eenv-stream/app.env
sudo -u deploy nano /opt/eenv-stream/app.env

sudo install -o deploy -g deploy -m 644 /dev/null /etc/caddy/eenv-stream-upstream.caddy
echo 'reverse_proxy 127.0.0.1:3002' | sudo -u deploy tee /etc/caddy/eenv-stream-upstream.caddy

# Les buckets RustFS ne sont PAS créés ici : leur configuration couvre AUSSI le
# bucket du portail (politiques par préfixe + CORS), elle vit donc dans le dépôt
# `context` — voir context/docs/RUNBOOK.md, étape 3.

# Bloc Caddy — EN DERNIER, une fois le service sain en local
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F-%H%M)
sudo tee -a /etc/caddy/Caddyfile < caddy/eenv-stream.caddy
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
sudo caddy reload   --adapter caddyfile --config /etc/caddy/Caddyfile
```

Clé de déploiement, dans `~deploy/.ssh/authorized_keys` :

```
restrict,command="/opt/eenv-stream/ssh_command.sh" ssh-ed25519 AAAA… github-actions-eenv-stream
```

## Usage

```bash
sudo -u deploy /opt/eenv-stream/deploy.sh status
sudo -u deploy /opt/eenv-stream/deploy.sh ghcr.io/nouvelle-vie-platform/streaming-service:v1.0.1
sudo -u deploy /opt/eenv-stream/deploy.sh rollback
```

## Ce que fait un déploiement

```
pull → migrations → démarrage serveur + worker de la couleur inactive
     → /health → vérification que le worker tourne → bascule Caddy
     → drain 120 s → arrêt de l'ancien serveur → arrêt de l'ancien worker (≤ 10 min)
```

Deux verrous avant la bascule, et non un seul : `/health` prouve que PostgreSQL, Redis **et RustFS**
répondent ; la vérification du worker évite le cas où le serveur est sain mais le worker s'est
écroulé — un service qui accepte les fichiers et n'en encode aucun.

## ⚠️ Deux choses à ne jamais faire

**Ne jamais ajouter `encode` au niveau du site Caddy.** La compression casse la reprise de
téléchargement par plage sur `/dl/*` (spike #184). Elle est déclarée dans le seul bloc fourre-tout.

**Ne jamais changer `HLS_PUBLIC_BASE_URL`.** Cette URL est écrite en dur en base dans chaque
enseignement transcodé (ADR-0006). La modifier casse **tous** les audios déjà publiés.
