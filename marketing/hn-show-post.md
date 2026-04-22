# Show HN — Axon

> **Post time:** Tuesday, 08:00 ET (best historical window for Show HN traction)
> **Title:** keep it under 80 chars, no emoji, no hype words
> **Link:** point to the docs/demo page, not the landing's waitlist

---

## Title (try these in order of strength)

1. `Show HN: Axon – One endpoint and one USDC wallet for every paid API an agent needs`
2. `Show HN: Axon – x402 gateway so AI agents can pay for APIs autonomously`
3. `Show HN: Axon – API marketplace for autonomous agents, paid per request in USDC`

Use #1 first. If it doesn't catch in 30 minutes, delete and resubmit with #2 at a different hour.

---

## Body (first comment, posted by you immediately after submission)

> Hi HN — builder of Axon here.
>
> Short version: if you're building an autonomous agent, you've probably hit the wall where the agent needs 10+ paid APIs to do real work, and every single one needs its own signup, API key, billing method, and SDK. Agents can't handle that. Humans shouldn't have to.
>
> Axon is a gateway that sits in front of a growing catalog of paid APIs. You deposit USDC on Base once, and then call any API with a single endpoint:
>
>     POST /v1/call/{api}/{endpoint}
>     Header: x-api-key: ax_live_…
>
> The response carries `x-axon-cost-usdc` and `x-axon-cache`, so your agent sees exactly what it paid and whether the answer came from cache. Cache hits are served at 50% of list price.
>
> **What's in the catalog at launch:** OpenAI, Anthropic, Firecrawl, SerpAPI, Exa, Tavily, Replicate, ElevenLabs, Deepgram, Apollo, OpenWeather, Stripe Issuing. Adding ~5/week.
>
> **What's under the hood:**
> - Bun + Hono on the edge
> - Postgres (Drizzle) for the ledger
> - Redis for cache (content-addressed by sorted param hash)
> - Atomic wallet debits with reserved-balance pattern
> - Per-endpoint pricing + markup + TTL in a JSON registry (adding an API ≈ 15 min of config)
> - Refund path on upstream 4xx/5xx so you're never charged for failed calls
>
> **What's not done yet / honest disclosure:**
> - LLM calls are currently flat-priced, not token-metered. Next two weeks.
> - x402 native mode (pay per call without pre-deposit) is stubbed — pre-paid wallet works today.
> - Fallback routing across providers is roadmap, not shipped.
>
> **Why we think this matters:** agents want to buy things. Right now they can't, because the payment rails weren't built for them — they were built for humans with credit cards and monthly subscriptions. x402 changes that. Axon is the aggregation layer on top.
>
> **Pricing:** 15% markup on free tier (with $5 signup credit), 5% on $49/mo Pro, 3% on $199/mo Team. Cache hits charged at 50% of list price regardless of tier.
>
> Questions, roasts, "this is dumb because X" — all welcome. Demo + docs at axon.dev.

---

## Expected objections — draft replies to have ready

### "Why not just use OpenRouter?"

> OpenRouter is great for LLMs and basically invented the market. Axon is horizontal instead of vertical — we do LLMs too, but also scraping, search, enrichment, weather, voice, finance, geo, etc. Different customer: the autonomous agent that needs a dozen API categories behind one endpoint, not the chat app that needs one LLM router.

### "Why do you need to exist if APIs can just expose x402 directly?"

> They can, and more will. Our value-add isn't the payment rail — it's the catalog, caching layer, unified billing, and the wrapping of APIs that *don't* speak x402 yet. We think the middle layer stays valuable even as x402 adoption grows, for the same reason Plaid stayed valuable after banks built APIs.

### "What stops you from becoming a marketplace where the best-funded vendor wins?"

> We publish per-API cache-hit rate and median latency on a public dashboard. Ranking is by performance and usage, not ad spend. No paid placement at launch.

### "How is this different from AWS Marketplace / RapidAPI?"

> RapidAPI is for humans who discover APIs via a web UI. Axon is for agents that discover APIs via a listing endpoint and pay via their wallet. No human account creation, no subscription management, no UI for the agent to click through. Fundamentally different target user.

### "Custodial wallet = trust problem."

> Fair. Two things: (1) current spend caps mean the maximum at-risk is small (your wallet balance), and (2) the roadmap includes non-custodial x402 native mode where your client signs each payment directly.

---

## Followup etiquette

- Reply to every substantive comment within 30 min for the first 4h
- Don't argue with trolls; upvote good counterpoints
- If a comment exposes a real gap, thank them publicly and add it to the roadmap in the thread
- Share metrics honestly ("we had X signups in 6h") — HN respects transparency
