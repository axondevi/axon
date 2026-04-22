# Launch with $0

You don't need a paid domain, paid hosting, or paid APIs to launch Axon and accept your first user. Every piece of this stack has a free tier that covers the first 1-5k requests/day. Upgrade only when you have revenue to pay for it.

This guide is the actual, working path. No "sign up for free trial and remember to cancel before the 30 days." Each service here is genuinely free at the volume of an early-stage launch.

---

## The free-tier stack

| Piece | Service | Free tier | Upgrade trigger |
|-------|---------|-----------|-----------------|
| Landing page | **Cloudflare Pages** | Unlimited static + custom subdomain on `*.pages.dev` | Never — free forever |
| API server | **Render** (free web service) | 512 MB RAM, spins down after 15min idle | ~$7/mo when traffic warrants always-on |
| Postgres | **Neon** | 512 MB storage, 3GB data transfer, serverless | $19/mo when you exceed 512 MB |
| Redis | **Upstash** | 10k commands/day, 256 MB max | $0.20 per 100k after — pay-per-use |
| Cron / worker | **GitHub Actions** (scheduled) | 2000 min/mo free | Never — 2000 min is a year of daily runs |
| Blockchain deposit watcher | **Alchemy** | 300 CU/sec free tier | ~$49/mo at real volume |
| Wallet custody (testnet) | **Coinbase CDP** | Free dev tier | Migrate to mainnet once you have users |
| Domain | Subdomain on any of the above | — | Buy `.dev` domain for ~$12/year when revenue covers it |
| SSL | Included in every service above | — | Never |

**Total monthly cost: $0.** Covers ~2,000 requests/day comfortably. Upgrade piece by piece as revenue comes in.

---

## Step-by-step (about 90 minutes total)

### 0. Prereqs (5 min)

- A GitHub account (free)
- Git installed
- Node 18+ or Bun installed for local dev

### 1. Push Axon to GitHub (10 min)

```bash
cd ~/Desktop/axon
git init
git add -A
git commit -m "Initial Axon code"
```

Create a new **private** repo on GitHub (don't make it public until you've rotated any committed secrets — but since we use `.env.example` and `.gitignore` excludes `.env`, you should be fine):

```bash
gh repo create axon --private --source . --push
```

If you don't have `gh` CLI, create the repo in the GitHub web UI and push manually.

### 2. Postgres on Neon (5 min)

1. Go to [neon.tech](https://neon.tech) → Sign up with GitHub (no credit card required)
2. Create project: name `axon-prod`, region closest to you
3. Copy the **Pooled connection** URL — starts with `postgres://`
4. Save it somewhere — you'll paste it into Render in step 4

### 3. Redis on Upstash (5 min)

1. Go to [upstash.com](https://upstash.com) → Sign up with GitHub (no credit card required)
2. Create a Redis database, region = same as Neon
3. Copy the **REDIS_URL** (starts with `rediss://` — note the double s, TLS)
4. Save it

### 4. Backend on Render (20 min)

1. Go to [render.com](https://render.com) → Sign up with GitHub (no credit card for free web service)
2. **New → Blueprint → connect your `axon` repo**. Render reads `render.yaml` at root and creates the service
3. Set environment variables in the dashboard:
   - `DATABASE_URL` — from Neon
   - `REDIS_URL` — from Upstash
   - `MASTER_ENCRYPTION_KEY` — generate: `openssl rand -hex 32`
   - `ADMIN_API_KEY` — generate: `openssl rand -hex 32`
   - `WALLET_PROVIDER=placeholder` (start with placeholder, swap to CDP later)
   - `NODE_ENV=production`
   - `LOG_FORMAT=json`
4. Deploy happens automatically from the blueprint
5. Once live, your URL is something like `https://axon-xxxxx.onrender.com`
6. Test: `curl https://axon-xxxxx.onrender.com/health` → should return `{"status":"ok"}`

### 5. Run database migration (2 min)

From Render dashboard → Shell tab (or locally with the `DATABASE_URL` set):

```bash
bun run db:migrate
bun run seed   # creates demo user, prints ax_live_ key
```

Save the demo API key — it's your first working credential.

### 6. Landing page on Cloudflare Pages (15 min)

1. Go to [pages.cloudflare.com](https://pages.cloudflare.com) → Sign up (no card)
2. **Connect to Git → select `axon` repo**
3. Build settings:
   - Framework preset: **None**
   - Build command: (leave empty)
   - Build output directory: `landing`
4. Deploy. Your landing is now at `https://axon.pages.dev` (or pick a custom name)
5. Edit the landing HTML to point at the Render backend:
   - In `landing/stats.html` change the hardcoded `https://api.axon.dev` to `https://axon-xxxxx.onrender.com`
   - Commit and push — Cloudflare auto-redeploys

### 7. Get 3-5 upstream API keys (30 min)

All free-tier. Pick the ones your first use case needs:

- **OpenWeather** — [home.openweathermap.org](https://home.openweathermap.org/users/sign_up) — 1000 free calls/day
- **SerpAPI** — [serpapi.com/users/sign_up](https://serpapi.com/users/sign_up) — 100 free/month
- **Firecrawl** — [firecrawl.dev](https://firecrawl.dev) — 500 free credits
- **Exa** — [exa.ai](https://dashboard.exa.ai) — 1000 free/month
- **Tavily** — [tavily.com](https://app.tavily.com) — 1000 free/month
- **OpenAI** — bring your own key; the free ones are rate-limited hard
- **Anthropic** — [console.anthropic.com](https://console.anthropic.com) — $5 free credit

Add each one to Render env vars: `UPSTREAM_KEY_OPENWEATHER=...`, etc.

Redeploy — new env vars take effect.

### 8. GitHub Actions cron for settlement (5 min)

No need for an always-on worker. GitHub Actions runs free daily cron.

Create `.github/workflows/settle.yml` (already in the repo as an example template — just fill in your URL + admin key as repo secrets):

```yaml
name: daily-settlement
on:
  schedule:
    - cron: '0 2 * * *'   # 02:00 UTC daily
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger settlement
        run: |
          curl -fsS -X POST "${AXON_URL}/v1/admin/settlements/run" \
            -H "x-admin-key: ${AXON_ADMIN_KEY}"
        env:
          AXON_URL: ${{ secrets.AXON_URL }}
          AXON_ADMIN_KEY: ${{ secrets.AXON_ADMIN_KEY }}
```

Add `AXON_URL` and `AXON_ADMIN_KEY` as repository secrets.

---

## What your URLs look like at $0

- **Landing**: `https://axon.pages.dev` (or your-chosen-name.pages.dev)
- **API**: `https://axon-xxxxx.onrender.com`
- **Admin dashboard**: open `admin/dashboard.html` locally in a browser; it connects to your API via the base URL you enter at login
- **Public stats**: `https://axon.pages.dev/stats.html`
- **Docs**: push `docs/` to Cloudflare Pages too (separate project) → `https://docs-axon.pages.dev`

No paid domain needed. Subdomains on `.pages.dev` and `.onrender.com` are permanent and free.

---

## When to buy a real domain

You'll know you should buy a domain when:
- You have at least one paying user contributing >$20/mo in take-rate
- You want to send cold emails (people trust `founder@axon.dev` more than `founder@axon-dev.onrender.com`)
- You want to run ads or do press

A `.dev` or `.ai` domain is ~$12-30/year. Use **Cloudflare Registrar** — they sell at cost, no markup. Move DNS to Cloudflare (already free).

Then:
- Add `api.axon.dev` → Render CNAME
- Add `axon.dev` → Cloudflare Pages custom domain
- Add `docs.axon.dev` → Cloudflare Pages custom domain
- Update landing/docs to reference the new domain

---

## Safety checklist before accepting real money

Even on testnet, follow this:

- [ ] **Testnet first** — start with `CDP_NETWORK_ID=base-sepolia`, fund wallets with free Sepolia USDC from a faucet. Confirm end-to-end flow: deposit → call → refund.
- [ ] **`MASTER_ENCRYPTION_KEY` backed up** in two places (1Password + a paper copy in a drawer). Losing it = losing custody of upstream keys.
- [ ] **Rate limits active** (free tier: 10 req/min on every user) — already on by default in Axon
- [ ] **`/metrics` endpoint not public** — set `METRICS_TOKEN` env var so only your monitoring can scrape it. On Render free tier, you can leave it open since you're not worried about competitive scrape-bots yet.
- [ ] **Admin routes unreachable from public internet** if possible. On Render free tier, the URL is guessable but not indexed — fine for now. Rotate `ADMIN_API_KEY` if it ever leaks.
- [ ] **GitHub repo is private** until you're ready to open-source the core.

---

## Real numbers: what $0 covers

Running axon on the stack above, a realistic early-stage month looks like:

| Metric | Value |
|--------|-------|
| Requests handled | ~60,000/month (2k/day avg) |
| Users | 1-100 |
| Neon Postgres size | < 100 MB |
| Upstash ops | < 300k/month |
| Render cold starts | ~10/day (each adds 2-5s latency on first request) |
| Your out-of-pocket | **$0** |

When you outgrow this:

- Render Hobby ($7/mo): no cold starts, always-on
- Neon Pro ($19/mo): 10 GB, branching, better support
- Upstash pay-as-you-go: ~$5/mo at 1M ops
- Domain: $12/year
- **Total ~$35/mo — sustainable with ~$100 MRR**

---

## What you DON'T need (yet)

- A company / LLC
- A business bank account
- A lawyer
- A trademark
- Paid monitoring (Sentry, Datadog)
- A CDN (Cloudflare Pages already is one)
- Paid email (use Gmail with your name, people don't care at this stage)
- Stripe account (you're on USDC — Stripe is for humans, not your product)

---

## Your first 72 hours, timeboxed

- **Hour 0-2**: Follow steps 1-6 above. You now have a live API + landing.
- **Hour 2-4**: Follow step 7 — get 3 upstream keys working. Test `curl .../v1/call/openweather/current` end-to-end.
- **Hour 4-8**: Write or record a 30-second demo video using `marketing/demo-video-script.md`.
- **Hour 8-24**: Tweet the launch using `marketing/twitter-launch-thread.md`. Post on HN (optional — only if HN karma is healthy).
- **Hour 24-72**: Reply to every comment. DM 20 builders from the LangChain/crewAI discord. Offer personal onboarding + $5 credit.

Aim for **10 API keys issued** in 72h. That's a successful launch. MRR comes in weeks 2-4.

---

## If something breaks

1. Check `/health/ready` → tells you if DB or Redis is unreachable
2. Check Render logs → structured JSON, grep by `request_id`
3. Check Upstash dashboard for Redis command rate
4. Check Neon dashboard for connection count / storage
5. If `/metrics` is reachable: `curl .../metrics | grep axon_requests_total`

Every problem at $0 scale is one of these four. Production-grade monitoring (Sentry, Grafana) comes later.
