#!/usr/bin/env bash
# Rejoue les contrôles qui ont tranché le spike #184 (ADR-0012) contre n'importe quelle
# URL publique d'un rendu `.aac` — après un changement de Caddy, l'ajout d'un CDN, ou une
# mise à jour de RustFS.
#
#   scripts/verifier-reprise.sh https://stream.…/dl/<id>/low.aac [--entier]
#
# Sans `--entier` : recollage fenêtré (4 × 256 Kio contre un tir contigu de 1 Mio) — quelques
# secondes. Avec : la reprise à 50 % sur le fichier complet, qui télécharge deux fois l'objet.
#
# ⚠️ Ne jamais sonder le support des plages avec `curl -I` : RustFS répond `200` à un `HEAD`
# porteur de `Range` (mesuré, ADR-0012). Tout contrôle passe par un `GET`.
set -u
URL=${1:?usage: verifier-reprise.sh <url> [--entier]}
ENTIER=${2:-}
C="curl -sS --max-time 900"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ok=0; ko=0
verdict() { # verdict <libellé> <attendu> <obtenu>
  if [ "$2" = "$3" ]; then ok=$((ok+1)); printf 'OK   %-34s %s\n' "$1" "$3"
  else ko=$((ko+1)); printf 'ÉCHEC %-33s attendu %s, obtenu %s\n' "$1" "$2" "$3"; fi
}
code() { $C -o /dev/null -w '%{http_code}' "$@" "$URL"; }

ETAG=$($C -I "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
LEN=$($C -I "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')
echo "objet : $LEN octets, ETag $ETAG"
[ -n "$LEN" ] || { echo "objet injoignable"; exit 1; }

verdict "GET + Range"            206 "$(code -r 100-200)"
verdict "plage suffixe"          206 "$(code -r -1024)"
verdict "plage hors limites"     416 "$(code -r $((LEN+1000))-$((LEN+2000)))"
verdict "ETag stable (2e tir)"   "$ETAG" "$($C -I "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')"
verdict "Accept-Ranges"          bytes "$($C -I "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="accept-ranges"{print $2}')"
# Le piège qui ferait tout casser en silence : une compression sur ces octets.
verdict "aucune compression"     vide "$($C -r 100-200 -H 'Accept-Encoding: gzip, br, zstd' -D - -o /dev/null "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}' | grep . || echo vide)"
# Déviation connue de RustFS : `If-Range` est ignoré (206 au lieu de 200 sur validateur périmé).
# Pas un échec — un état mesuré. Si cette ligne change, le moteur mobile peut s'alléger.
printf 'NOTE If-Range sur validateur périmé  %s (RFC : 200 ; RustFS ignorait en 2026-10)\n' \
  "$(code -r 1000-1099 -H 'If-Range: "perime00000000000000000000000000"')"

echo "-- recollage fenêtré (4 × 256 Kio == 1 Mio contigu)"
$C -r 0-1048575 -o "$TMP/ref" "$URL"
for i in 0 1 2 3; do $C -r $((i*262144))-$(((i+1)*262144-1)) -o "$TMP/w$i" "$URL"; done
cat "$TMP"/w0 "$TMP"/w1 "$TMP"/w2 "$TMP"/w3 > "$TMP/recolle"
verdict "checksum fenêtré" "$(shasum -a 256 < "$TMP/ref")" "$(shasum -a 256 < "$TMP/recolle")"

if [ "$ENTIER" = "--entier" ]; then
  echo "-- reprise réelle à 50 % sur $LEN octets (deux téléchargements complets)"
  H=$((LEN/2))
  $C -o "$TMP/plein" "$URL"
  $C -r 0-$((H-1)) -o "$TMP/p1" "$URL"
  $C -r $H- -H "If-Range: $ETAG" -o "$TMP/p2" "$URL"
  cat "$TMP/p1" "$TMP/p2" > "$TMP/colle"
  verdict "checksum reprise 50 %" "$(shasum -a 256 < "$TMP/plein")" "$(shasum -a 256 < "$TMP/colle")"
fi

echo "— $((ok+ko)) contrôles : $ok OK, $ko en échec"
[ "$ko" -eq 0 ]
