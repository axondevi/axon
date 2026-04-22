---
subject: Welcome to Axon — your wallet is live
preheader: Your $5 credit is loaded. Here's your API key and 3 minutes to your first call.
vars: [name, api_key, deposit_address, dashboard_url]
---

Hey {{name}},

You're in. Here's everything you need:

**Your API key**: `{{api_key}}`
**Your deposit address**: `{{deposit_address}}`
**Starting balance**: $5 USDC (on us)

---

### Your first call, in under 60 seconds

```
curl "https://api.axon.dev/v1/call/openweather/current?lat=38.72&lon=-9.14" \
  -H "x-api-key: {{api_key}}"
```

You'll get the weather + three headers:

- `x-axon-cost-usdc` — what you paid
- `x-axon-cache` — `hit` or `miss`
- `x-axon-latency-ms` — end-to-end time

Run the same call again — cache hit, 50% off.

---

### What's in the catalog

OpenAI · Anthropic · SerpAPI · Firecrawl · Exa · ElevenLabs · Deepgram · Apollo · Clearbit · Hunter · Voyage · Jina · Mindee · IPinfo · OpenWeather · DeepL · Replicate · Stability · Runway · Together · Perplexity · Brave · Cartesia · Tavily · Neynar · Alchemy · Bright Data.

27 APIs, one key, one wallet, per-request pricing.

---

### What to do next

1. **Browse your dashboard**: {{dashboard_url}}
2. **Top up when you're ready**: send USDC on Base to `{{deposit_address}}`
3. **Integrate with your agent framework**: LangChain, crewAI, Vercel AI SDK, Mastra — [pick your SDK](https://axon.dev/docs)
4. **Reply to this email** if anything's broken. I read every reply.

— the Axon team
