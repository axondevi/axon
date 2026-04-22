# Axon Launch Checklist

> Work top-to-bottom. Don't skip steps. Don't jump to marketing before the product runs.

---

## Phase 0 — Name & domain (this week)

- [ ] Pick final brand name (axon is codename; verify axon.dev / .ai is free or pivot)
- [ ] Register domain (Namecheap, Cloudflare Registrar)
- [ ] Grab matching Twitter/X handle, GitHub org, Discord server
- [ ] Buy matching `.dev` for docs subdomain as well

**Alternatives if `axon` is taken:** `meterpay`, `onrail`, `plexapi`, `reqpay`, `conduit.dev`, `axonpay`, `relay402`, `402.dev`.

---

## Phase 1 — Local dev working (days 1-3)

- [ ] `bun install` completes
- [ ] `docker compose up -d` runs Postgres + Redis
- [ ] `.env` filled with all keys
- [ ] `bun run db:push` creates schema
- [ ] `bun run dev` starts cleanly
- [ ] `curl /health` returns 200
- [ ] Admin: create a user, get back API key
- [ ] Hit `/v1/apis` — see the 5 APIs
- [ ] Hit `/v1/call/openweather/current?lat=38.72&lon=-9.14` — get response + cost header
- [ ] Hit again — see `x-axon-cache: hit` and 50% cost

---

## Phase 2 — Upstream credentials (days 2-4)

Signup and free-tier tokens for:

- [ ] OpenAI (platform.openai.com)
- [ ] Firecrawl (firecrawl.dev)
- [ ] SerpAPI (serpapi.com — 100 free/mo)
- [ ] Exa (exa.ai)
- [ ] OpenWeather (openweathermap.org — 1k free/day)

Later additions (week 2):
- [ ] Anthropic (console.anthropic.com)
- [ ] Tavily
- [ ] Replicate
- [ ] ElevenLabs
- [ ] Deepgram
- [ ] Apollo (much harder free tier; expect paid)

---

## Phase 3 — Hosting (days 4-6)

- [ ] Pick host: Railway (easiest) or Fly.io (more control)
- [ ] Deploy Axon as web service
- [ ] Managed Postgres (Neon is cheapest to start; Supabase if you want GUI)
- [ ] Managed Redis (Upstash pay-per-request; free tier is fine until ~10k req/day)
- [ ] Point `api.axon.dev` → your deploy
- [ ] Point `axon.dev` → landing (Cloudflare Pages / Vercel, static)

---

## Phase 4 — Wallet infra (days 5-10)

This is the part that actually handles real money. Don't rush.

- [ ] Pick custody model:
  - **Coinbase CDP Wallets** — cleanest API, no self-custody liability (recommended)
  - **Privy** — similar, more AI-native positioning
  - **viem + custodial EOA** — full control, full liability (NOT recommended for MVP)
- [ ] Create per-user sub-wallets on signup (replace the placeholder in `src/routes/wallet.ts`)
- [ ] Implement deposit watcher:
  - Option A: poll Base for USDC transfers to your deposit addresses (cheap, lower latency tolerable for MVP)
  - Option B: Alchemy webhooks on address activity (best)
  - Option C: CDP webhook events (cleanest if using CDP)
- [ ] Credit wallet via `POST /v1/admin/credit` when deposit confirms
- [ ] Test on **Base Sepolia testnet first**, then flip to mainnet
- [ ] Write a runbook for manual credit recovery if the watcher misses an event

---

## Phase 5 — Observability (days 8-10)

- [ ] Axiom or Tinybird ingesting all request logs
- [ ] Slack webhook on: deposits, failed calls, upstream 5xx rate > 5%
- [ ] Public status page (status.axon.dev) — pointing at uptime + daily call volume
- [ ] Internal dashboard (can be read-only Drizzle Studio + Tinybird views)

---

## Phase 6 — Legal minimum (days 7-12)

- [ ] Terms of service (get an actual lawyer or use a service like GetTerms)
- [ ] Privacy policy (must mention: IP logging, wallet addresses, payment data)
- [ ] Acceptable use policy (explicitly ban scraping PII, CSAM, sanctioned entities)
- [ ] If you're taking custody of USDC in a regulated jurisdiction (EU, US), talk to a lawyer BEFORE launch — this may trigger money transmitter licensing

---

## Phase 7 — Closed beta (week 2)

- [ ] DM 20 builders on Twitter/X in the agent ecosystem
- [ ] Give each one $50 credit + direct Telegram/Discord line
- [ ] Document every friction point. Fix within 24h.
- [ ] Collect 3-5 quotes for marketing (with permission)
- [ ] Collect use cases — these become your launch tweets

---

## Phase 8 — Public launch (week 3-4)

Execution order matters. Don't batch.

**Day -7:** open waitlist form on landing. Start tweeting about the build publicly.

**Day -3:** freeze code. Final stress-test. Make sure Axiom alerts work.

**Day 0 (Tuesday, 08:00 ET):**
1. Post Show HN (title + body from `marketing/hn-show-post.md`)
2. Pin Twitter thread (from `marketing/twitter-launch-thread.md`)
3. DM 5 influencers you have relationships with — ask them to amplify IF they find it useful (never demand)

**Day 0, 13:00 ET:** Reply to every HN and Twitter comment.

**Day 0, 16:00 ET:** Update your status. "Launched 6h ago. X signups. Y calls. Cache hit rate Z%." People love live numbers.

**Day +1 to +3:** Reddit posts, one per sub per day. Never paste the same body.

**Day +7:** Ship one public improvement (a new API, a new feature) and tweet about it. Shows momentum.

---

## Phase 9 — First-100 playbook (weeks 2-6)

- [ ] Personally email/DM every signup within 4h of activation
- [ ] Book 10 calls with power users. Ask: "what would make you churn?"
- [ ] Ship one feature per week pulled directly from their feedback
- [ ] At user #100: write a public retrospective. Numbers, quotes, hard truths.

---

## Phase 10 — Revenue milestones

Track these publicly (on a `/metrics` page). Transparency = credibility.

| Milestone | What it proves |
|-----------|----------------|
| 10 paying users | The offer is viable |
| $1k GMV through platform | The model works |
| 30% cache hit rate | The margin thesis holds |
| $5k MRR | Worth going full-time on |
| One unsolicited partnership inquiry | The market sees you |
| $50k MRR | Hire someone |

---

## Things NOT to do

- ❌ Build a mobile app
- ❌ Accept fiat in the first 3 months (adds compliance burden)
- ❌ Onboard a big customer with custom SLAs before you have 50 small ones
- ❌ Negotiate upstream wholesale discounts before you have demand signal
- ❌ Hire anyone before $50k MRR
- ❌ Raise money before you have $10k MRR (dilution is the enemy early)
- ❌ Open-source the whole thing — open-source the client SDK only

---

## Weekly review template

Every Friday, 30 minutes, written down:

1. Signups this week:
2. Active paying users:
3. GMV this week:
4. Cache hit rate:
5. Biggest friction a user told me about:
6. One thing I'll ship next week:
7. One thing I'll *stop* doing next week:
