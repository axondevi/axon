# Production Deploy

Minimal path to a publicly-accessible Axon in ~30 minutes.

## Stack choice

| Component | Recommended | Why |
|-----------|-------------|-----|
| Compute | **Railway** | Deploy Bun directly from GitHub, built-in env, <5 min setup |
| Postgres | **Neon** | Serverless, generous free tier, branching for staging |
| Redis | **Upstash** | Pay-per-request, no idle cost, 10k free/day |
| Wallet custody | **Coinbase CDP Wallets** | Per-user sub-wallets via API, SOC2-compliant custody |
| On-chain watcher | **Alchemy Webhooks** | "Address Activity" webhook on Base, signed delivery |
| Edge / DNS | **Cloudflare** | DNS + optional Workers proxy if you want edge caching |
| Observability | **Axiom** | Structured logs, fast queries, 500GB free |

## Step-by-step

### 1. Push the repo to GitHub (private)

```bash
cd ~/Desktop/axon
git init
git add -A
git commit -m "Initial Axon scaffold"
gh repo create axon --private --source . --push
```

### 2. Create the database (Neon)

- Sign up at neon.tech
- Create project → copy the pooled connection string
- Save it as `DATABASE_URL` in Railway env later

### 3. Create Redis (Upstash)

- Sign up at upstash.com
- Create Redis database → Base region (Global if low-latency worldwide)
- Save `REDIS_URL` (rediss://…)

### 4. Deploy to Railway

```bash
brew install railway   # or: npm i -g @railway/cli
railway login
railway init axon
railway up
```

In the Railway dashboard:
- Add env vars from `.env.example` (generate fresh secrets: `openssl rand -hex 32`)
- Attach your custom domain (`axon-kedb.onrender.com`) or use the Railway-provided URL
- Enable autoscaling: min 1, max 3 instances

### 5. Run migrations

```bash
railway run bun run db:push
```

### 6. Seed (optional)

```bash
railway run bun run seed
```

Save the printed API key — this is your first user.

### 7. Set up Coinbase CDP wallets

In your CDP dashboard:
- Create a project → copy the API key + secret
- Add them to Railway env: `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE`
- Uncomment the CDP integration in `src/wallet/deposits.ts` (MVP placeholder → real per-user address generation — this is roadmap, not shipped yet in v0.1)

For v0.1, the placeholder deposit address generator works but the watcher must be paired with a shared treasury wallet you operate manually.

### 8. Set up Alchemy webhook

- Create Alchemy app on Base Mainnet
- Create "Address Activity" webhook → your endpoint: `https://axon-kedb.onrender.com/v1/webhooks/alchemy`
- Add watched addresses: all user deposit addresses (API for this via Alchemy Notify)
- Copy the signing key → `ALCHEMY_WEBHOOK_SIGNING_KEY` in Railway env

### 9. Landing page (Cloudflare Pages)

```bash
cd landing
# Cloudflare Pages: point at the `landing/` folder of your GitHub repo
# Or: drag-and-drop upload at pages.cloudflare.com
```

DNS: `axon.dev` → Cloudflare Pages · `axon-kedb.onrender.com` → Railway

### 10. Observability

- Axiom: create dataset `axon-requests`, generate API token
- Add a minimal logging hook in `src/index.ts` to POST request metadata
- Pin a Slack webhook to fire on: deposit, upstream 5xx rate > 5%, zero-balance users

---

## Costs at 10k req/day

| Item | Cost |
|------|------|
| Railway (1-3 instances, 1GB RAM) | $15-30 / mo |
| Neon Pro | $19 / mo |
| Upstash Redis (pay-as-you-go) | $3-8 / mo |
| Alchemy (free tier covers this volume) | $0 |
| Cloudflare Pages + DNS | $0 |
| Axiom (free tier) | $0 |
| **Total** | **~$45 / mo** |

At 10k req/day with 30% cache hits and avg $0.006 per call, GMV ≈ $1800/mo, take-rate ≈ $180/mo. Break-even on infra around 3k req/day.

---

## Hardening checklist before sending money

- [ ] Test deposit flow end-to-end on **Base Sepolia testnet** first
- [ ] Verify webhook signature verification actually rejects forged requests
- [ ] Test refund path: simulate upstream 500, confirm balance restored
- [ ] Load test: `bombardier -c 50 -d 60s`  against a test endpoint; ensure no dropped debits
- [ ] Verify idempotency: replay the same Alchemy webhook twice, confirm no double-credit
- [ ] Lock Postgres with read-only replica for analytics
- [ ] Put rate limiter in place (Hono middleware, Redis-backed)
- [ ] Enable TLS everywhere; reject non-HTTPS
- [ ] Log but don't store raw API keys
- [ ] Rotate `MASTER_ENCRYPTION_KEY` never — it's the root of all upstream key encryption. Back it up.
- [ ] Set `ADMIN_API_KEY` to a real 32-byte random; never commit

---

## Rollback

If something breaks in production:

1. Railway has automatic rollback to last-deployed revision — use the dashboard
2. Neon has branch snapshots — restore from a pre-migration branch if schema broke
3. If wallet state is corrupt: **do not delete transactions**. They're the immutable audit trail. Add compensating entries.
