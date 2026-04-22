#!/usr/bin/env bash
# Smoke test for a locally running Axon instance.
# Prereqs: server running on :3000, `bun run seed` executed.
# Pass the demo API key as env:  AXON_KEY=ax_live_xxx ./scripts/smoke-test.sh

set -euo pipefail

BASE="${AXON_BASE:-http://localhost:3000}"
KEY="${AXON_KEY:?export AXON_KEY=... first}"

h() { echo; echo "── $1 ──"; }

h "health"
curl -s "$BASE/health" | jq

h "catalog"
curl -s "$BASE/v1/apis" | jq '.count, .data[0:3]'

h "wallet balance"
curl -s "$BASE/v1/wallet/balance" -H "x-api-key: $KEY" | jq

h "openweather: current (Lisbon)"
curl -s "$BASE/v1/call/openweather/current?lat=38.72&lon=-9.14" \
  -H "x-api-key: $KEY" -D /tmp/axon-headers.txt -o /tmp/axon-body.json
echo "Status: $(head -n1 /tmp/axon-headers.txt)"
grep -i "^x-axon" /tmp/axon-headers.txt || true
echo "body preview: $(jq -r '.name + " " + (.main.temp|tostring) + "K"' /tmp/axon-body.json 2>/dev/null || head -c 200 /tmp/axon-body.json)"

h "same call again (should be cache hit)"
curl -s "$BASE/v1/call/openweather/current?lat=38.72&lon=-9.14" \
  -H "x-api-key: $KEY" -D /tmp/axon-headers.txt -o /dev/null
grep -i "^x-axon" /tmp/axon-headers.txt || true

h "usage aggregate"
curl -s "$BASE/v1/usage" -H "x-api-key: $KEY" | jq

h "usage by api"
curl -s "$BASE/v1/usage/by-api" -H "x-api-key: $KEY" | jq

h "final balance"
curl -s "$BASE/v1/wallet/balance" -H "x-api-key: $KEY" | jq

echo
echo "✓ smoke test complete"
