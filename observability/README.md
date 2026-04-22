# Observability

## Prometheus

Scrape `/metrics` every 30-60 seconds:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: axon
    scrape_interval: 30s
    static_configs:
      - targets: ['axon-xxx.onrender.com']
    scheme: https
    # If METRICS_TOKEN is set:
    authorization:
      type: Bearer
      credentials: YOUR_METRICS_TOKEN
```

Metrics emitted:

- `axon_requests_total{api,endpoint,cache,status}` — counter
- `axon_request_cost_usdc_total{api,endpoint,cache}` — counter (micro-USDC)
- `axon_upstream_latency_ms_sum{api,endpoint}` — counter
- `axon_wallet_balance_micro{user_id}` — gauge (top 100)
- `axon_settlements_pending_total` — gauge

## Grafana

Import `grafana-dashboard.json` via **Dashboards → Import**. Select your Prometheus datasource on the import screen. The dashboard has:

- **Stat row**: requests/min · cache hit rate · 24h GMV · pending settlements
- **Timeseries row**: requests/s by API · error rate by API
- **Timeseries row**: avg upstream latency · cost per minute
- **Table**: top 20 wallets by balance

Variables:
- `$api` — multi-select filter across every panel

## Alerting starter rules

Drop into `alerts.yml` in Prometheus:

```yaml
groups:
  - name: axon
    rules:
      - alert: AxonHighErrorRate
        expr: |
          sum(rate(axon_requests_total{status=~"5.."}[5m]))
          / sum(rate(axon_requests_total[5m])) > 0.05
        for: 5m
        annotations:
          summary: "Axon error rate >5% for 5m"

      - alert: AxonPendingSettlementsBacklog
        expr: axon_settlements_pending_total > 30
        for: 2h
        annotations:
          summary: "More than 30 pending settlement rows"

      - alert: AxonLowCacheHitRate
        expr: |
          sum(rate(axon_requests_total{cache="hit"}[1h]))
          / sum(rate(axon_requests_total[1h])) < 0.15
        for: 30m
        annotations:
          summary: "Cache hit rate <15% — margin is suffering"
```

## Self-hosted alternatives

- **Signoz** — Prometheus + Grafana + tracing bundle, one docker-compose
- **Tinybird** — SQL over request logs if you ingest them
- **Axiom** — log-centric, good free tier
