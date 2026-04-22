#!/usr/bin/env bash
# Create your first user against a running Axon, print the credentials.
#
# Usage:
#   AXON_URL=https://axon-xxx.onrender.com \
#   AXON_ADMIN_KEY=<your admin key> \
#   bash scripts/first-user.sh you@example.com
set -euo pipefail

AXON_URL="${AXON_URL:?set AXON_URL}"
AXON_ADMIN_KEY="${AXON_ADMIN_KEY:?set AXON_ADMIN_KEY}"
EMAIL="${1:-demo@axon.local}"

echo "Creating user: $EMAIL"
echo "  against:     $AXON_URL"
echo

response=$(curl -fsS -X POST "$AXON_URL/v1/admin/users" \
  -H "content-type: application/json" \
  -H "x-admin-key: $AXON_ADMIN_KEY" \
  -d "{\"email\": \"$EMAIL\"}")

echo "$response" | jq .

echo
echo "─────────────────────────────────────────────────────────────"
echo "Save the api_key NOW — it cannot be retrieved later."
echo "─────────────────────────────────────────────────────────────"

api_key=$(echo "$response" | jq -r '.api_key')
if [ -n "$api_key" ] && [ "$api_key" != "null" ]; then
  echo
  echo "Try it:"
  echo "  curl \"$AXON_URL/v1/wallet/balance\" -H \"x-api-key: $api_key\""
fi
