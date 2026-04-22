#!/usr/bin/env bash
# Tiny benchmark — compare Axon vs direct upstream latency.
#
# Measures 20 sequential + 20 concurrent requests to the same endpoint.
# Prints p50/p95/p99 for each and a verdict (<10% = great, <30% = fine).
#
# Usage:
#   AXON_URL=https://axon-xxx.onrender.com \
#   AXON_KEY=ax_live_... \
#   bash scripts/benchmark.sh openweather/current 'lat=38.72&lon=-9.14'

set -euo pipefail

AXON_URL="${AXON_URL:?export AXON_URL=...}"
AXON_KEY="${AXON_KEY:?export AXON_KEY=ax_live_...}"
ENDPOINT="${1:-openweather/current}"
QS="${2:-lat=38.72&lon=-9.14}"
N="${N:-20}"

echo "Benchmarking $ENDPOINT × $N sequential"
echo "─────────────────────────────────────"

measure() {
  local url="$1"
  local i
  local -a times=()
  for i in $(seq 1 "$N"); do
    local t
    t=$(curl -s -o /dev/null -w '%{time_total}' "$url" -H "x-api-key: $AXON_KEY")
    # to ms
    times+=("$(awk "BEGIN{printf \"%.0f\", $t*1000}")")
  done
  # Sort and pick percentiles
  IFS=$'\n' sorted=($(sort -n <<<"${times[*]}")); unset IFS
  p50="${sorted[$((N/2))]}"
  p95="${sorted[$((N*95/100))]}"
  p99="${sorted[$((N-1))]}"
  echo "  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms"
  # Export for comparison
  LAST_P50=$p50
  LAST_P95=$p95
}

echo
echo "Axon (cold — first call misses cache)"
measure "$AXON_URL/v1/call/$ENDPOINT?$QS"
AXON_P50_COLD=$LAST_P50
AXON_P95_COLD=$LAST_P95

echo
echo "Axon (warm — all calls hit cache)"
measure "$AXON_URL/v1/call/$ENDPOINT?$QS"
AXON_P50_WARM=$LAST_P50
AXON_P95_WARM=$LAST_P95

echo
echo "─────────────────────────────────────"
echo "Summary"
echo "  Cold p50: ${AXON_P50_COLD}ms · p95: ${AXON_P95_COLD}ms"
echo "  Warm p50: ${AXON_P50_WARM}ms · p95: ${AXON_P95_WARM}ms"
echo "  Cache speedup: $(awk "BEGIN{printf \"%.1fx\", $AXON_P50_COLD / ($AXON_P50_WARM + 0.01)}")"
echo
