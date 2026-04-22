#!/usr/bin/env bash
# Readiness check — validates env, services, registry before you deploy.
# Run locally before pushing: AXON_URL=http://localhost:3000 bash scripts/check-readiness.sh
# Or against prod: AXON_URL=https://axon-xxx.onrender.com bash scripts/check-readiness.sh
set -uo pipefail

AXON_URL="${AXON_URL:-http://localhost:3000}"
pass=0
fail=0

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  ✓ $name"
    pass=$((pass+1))
  else
    echo "  ✗ $name"
    fail=$((fail+1))
  fi
}

echo
echo "Local environment"
echo "─────────────────"
check "bun installed"                        "command -v bun"
check "jq installed"                         "command -v jq"
check "curl installed"                       "command -v curl"
check ".env file exists"                     "[ -f .env ]"
check "registry/ has at least 5 APIs"        "[ \$(ls registry/*.json 2>/dev/null | wc -l) -ge 5 ]"

echo
echo "Registry validity"
echo "─────────────────"
missing=0
for f in registry/*.json; do
  if ! jq -e '.slug and .provider and .category and .base_url and .auth.type and (.endpoints | length > 0)' "$f" >/dev/null 2>&1; then
    echo "  ✗ $f — missing required fields"
    missing=$((missing+1))
  fi
done
if [ $missing -eq 0 ]; then
  echo "  ✓ all $(ls registry/*.json | wc -l) registry entries valid"
  pass=$((pass+1))
else
  fail=$((fail+missing))
fi

echo
echo "Server reachability ($AXON_URL)"
echo "───────────────────────────────"
check "/ returns 200"                         "curl -fsS --max-time 5 $AXON_URL/ > /dev/null"
check "/health returns 200"                   "curl -fsS --max-time 5 $AXON_URL/health > /dev/null"
check "/health/ready returns 200"             "curl -fsS --max-time 10 $AXON_URL/health/ready > /dev/null"
check "/v1/apis returns catalog"              "curl -fsS --max-time 5 $AXON_URL/v1/apis | jq -e '.data | length > 0' > /dev/null"
check "unauth request returns 401"            "[ \$(curl -o /dev/null -s -w '%{http_code}' $AXON_URL/v1/wallet/balance) = '401' ]"
check "unknown route returns 404"             "[ \$(curl -o /dev/null -s -w '%{http_code}' $AXON_URL/nonexistent) = '404' ]"
check "x-request-id header present"           "curl -fsS -D - -o /dev/null $AXON_URL/health | grep -qi x-request-id"

echo
echo "Upstream credentials (env)"
echo "──────────────────────────"
set -a
[ -f .env ] && . .env
set +a
for slug in openweather serpapi firecrawl exa openai anthropic; do
  var="UPSTREAM_KEY_$(echo "$slug" | tr 'a-z-' 'A-Z_')"
  if [ -n "${!var:-}" ]; then
    echo "  ✓ $var set"
    pass=$((pass+1))
  else
    echo "  ⚠ $var not set (optional — that API will 500)"
  fi
done

echo
echo "─────────────────"
echo "Passed: $pass · Failed: $fail"
if [ $fail -eq 0 ]; then
  echo "✓ Ready."
  exit 0
else
  echo "✗ Fix failures before deploying."
  exit 1
fi
