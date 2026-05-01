#!/usr/bin/env bash
# Minimal Axon shell example — curl only, no SDK.
#   AXON_KEY=ax_live_... bash curl-minimal.sh
set -euo pipefail

: "${AXON_KEY:?set AXON_KEY}"
BASE="${AXON_BASE:-https://axon-kedb.onrender.com}"

echo "── catalog ──"
curl -s "$BASE/v1/apis" | head -c 200; echo

echo
echo "── weather call ──"
curl -s "$BASE/v1/call/openweather/current?lat=38.72&lon=-9.14" \
  -H "x-api-key: $AXON_KEY" \
  -D /tmp/axon-hdrs.txt -o /tmp/axon-body.json

grep -i '^x-axon' /tmp/axon-hdrs.txt || true
echo "body: $(head -c 200 /tmp/axon-body.json)"

echo
echo "── wallet ──"
curl -s "$BASE/v1/wallet/balance" -H "x-api-key: $AXON_KEY"
echo
