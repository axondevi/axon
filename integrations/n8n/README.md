# n8n-nodes-axon

[n8n](https://n8n.io) community node for [Axon](https://axon.dev). Call any API in your Axon catalog from an n8n workflow — pay per request in USDC, no per-vendor API keys to manage.

## Install

In your self-hosted n8n (via UI: **Settings → Community Nodes**):

```
n8n-nodes-axon
```

Or via CLI:

```bash
npm install n8n-nodes-axon
```

Restart n8n.

## Set up credentials

1. **Credentials → New → Axon API**
2. Paste your `ax_live_...` key
3. (Optional) override base URL for self-hosted Axon
4. Test → should return `ok`

## Use in a workflow

Drop an **Axon** node onto the canvas. It'll:

1. Auto-populate the **API** dropdown with your catalog (loaded live)
2. Auto-populate the **Endpoint** dropdown with pricing per call
3. Accept any JSON input (mapped from upstream nodes)

Output includes the upstream response plus `_axon.cost_usdc`, `_axon.cache`, and `_axon.latency_ms`.

## Example workflow

```
[Cron every 10m]
  → [Axon: serpapi/search] { q: "AI agent news" }
  → [Axon: firecrawl/scrape] { url: "{{$json.top_link}}" }
  → [Axon: openai/chat] { model: "gpt-4o-mini", messages: [...] }
  → [Slack: post summary]
```

4 paid APIs, one wallet, no per-vendor setup.

## License

MIT
