# Demo Video — 30 seconds

Goal: someone who's never heard of Axon understands what it does in 30 seconds. Shared on Twitter/X, embedded on the landing hero, pinned in Product Hunt gallery.

**Total length: 30s · 6 shots · ~50 words of narration**

This V2 script is **gravable hoje com terminal + browser**. No Claude Desktop, no MCP setup, no custom recording software tricks. All 6 shots are real live traffic hitting the live API.

---

## Shot list

### Shot 1 · 0.0 – 4.0s · THE HOOK — BR DIFFERENTIATOR
**Visual:** Clean terminal, dark theme. Someone types slowly:

```bash
curl https://axon-kedb.onrender.com/v1/call/brasilapi/cnpj?cnpj=00000000000191 \
  -H "Authorization: Bearer ax_live_..."
```

Hits enter. After ~1.5s a JSON response streams in showing company name, partners, address from Receita Federal.

**Narration:**
> "One call. One wallet. Brazilian data straight from Receita Federal."

**On-screen overlay (bottom):** `🇧🇷 CNPJ via Axon · $0.0026 USDC`

---

### Shot 2 · 4.0 – 9.0s · GLOBAL REACH
**Visual:** Same terminal. User Ctrl+L clears. Types:

```bash
curl -X POST https://axon-kedb.onrender.com/v1/call/tavily/search \
  -H "Authorization: Bearer ax_live_..." \
  -d '{"query":"best espresso in Lisbon"}'
```

Response streams: 5 results with URLs.

**Narration:**
> "Web search. AI embeddings. 28 APIs behind one endpoint."

**On-screen overlay:** `🌐 Tavily · OpenAI · Jina · Voyage · +24 more`

---

### Shot 3 · 9.0 – 13.0s · CACHE HIT (the margin magic)
**Visual:** Same terminal. Runs the CNPJ call from Shot 1 again.

Response streams IDENTICAL — but the terminal's timer shows **`823ms`** (vs. `1820ms` the first time). A small HUD pops up:

```
cache: HIT
cost: $0.0013 (50% off)
```

**Narration:**
> "Cached responses cost half. Agents pay less. Your margin stays."

---

### Shot 4 · 13.0 – 18.0s · USAGE DASHBOARD
**Visual:** Cut to browser. Opens `axon-kedb.onrender.com/v1/usage` with the key in header (or the admin dashboard if polished).

Shows:
```json
{
  "total_requests": 16,
  "cache_hits": 3,
  "cache_hit_rate": 0.1875,
  "total_spent_usdc": "0.036500"
}
```

**Narration:**
> "Every call is accounted for. In USDC. On Base."

---

### Shot 5 · 18.0 – 24.0s · CATALOG LOGO WALL
**Visual:** Cut to `axon-5zf.pages.dev`. Scrolls to the `#apis` section — logo grid of 28 providers fades in in batches. BrasilAPI, OpenAI, Anthropic, Jina, Voyage, Tavily, Exa, Firecrawl, IPinfo, OpenWeather, Deepgram, ElevenLabs, Stability, Together, Replicate, DeepL, SerpAPI, Apollo, Mindee, Neynar, Alchemy, Brave Search, Perplexity, Cartesia, Runway, Bright Data, Hunter, Clearbit.

**On-screen overlay (corner):** `28 APIs · 1 wallet · pay-per-call`

**Narration:**
> "One endpoint for everything your agent needs."

---

### Shot 6 · 24.0 – 30.0s · CLOSE
**Visual:** Full-screen on dark bg. Logo (gradient circle) fades in center, then text:

> **axon**
> *the x402 gateway for AI agents*
>
> **axon-5zf.pages.dev** · $5 free to start
> *open source · MIT · 🇧🇷 built from São Paulo*

**Narration:** *(silence — let it land)*

---

## Production notes (simplified)

**All you actually need:**
- **OBS Studio** — free, download at obsproject.com. "Screen capture" source + "Audio input" if narrating.
- **Terminal** — Git Bash or Windows Terminal, font JetBrains Mono ≥16pt, dark theme matching Axon palette (`#0a0a0b` bg, `#19d5c6` accent).
- **Browser** — any. Clear address bar, no bookmarks bar visible, close extensions that show icons.
- **Microphone** — laptop's built-in is OK for v1. Narrate in a quiet room.

**Before hitting record, prep:**
- [ ] Export `AXON_KEY="ax_live_a97be57096f318c5bef86c8f5e5c49d246b667202e86ee77"` in the shell (so you don't have to paste it)
- [ ] Have the 3 commands ready in a notes file to copy-paste (don't type live — mistakes slow recording)
- [ ] Open the 2 browser tabs ahead: landing page scrolled to #apis, and usage endpoint response
- [ ] Record at 1080p (1920×1080), NOT 4K — Twitter caps at 1080p
- [ ] Frame rate: 30fps is enough

**After recording:**
- [ ] Trim dead air at beginning/end (QuickTime or Clipchamp — both free)
- [ ] Export MP4 at H.264 codec, bitrate ~8 Mbps
- [ ] File size target: <25 MB (Twitter's friendly limit)
- [ ] Keep the MP4 master uncompressed if you plan to re-use on landing/PH

**Narration alternative:**
If you don't want to narrate or are self-conscious about accent: **skip narration entirely**. Let on-screen text do the work. Silent product videos are a valid style (Linear does this well).

---

## Alt: 10-second ultra-short (for "raw" Twitter post)

Same storyline, 3 shots only:
1. (3s) CNPJ curl returns Brazilian data → overlay `🇧🇷 CNPJ via Axon`
2. (4s) Same call repeated → overlay `cache HIT · 50% off`
3. (3s) Logo + `axon-5zf.pages.dev`

---

## Alt: 90-second long-form (for the landing hero)

Everything above + a "behind the scenes" mid-section showing:
- Policy engine denying an over-budget call (`policy_denied`)
- Auto-refund when upstream returns 500
- Multi-framework integration: 3 seconds each showing LangChain, Vercel AI SDK, crewAI all using Axon

Length matters less for embedded video than for social — but never make people wait more than 5 seconds before showing something useful.

---

## Assets checklist

- [ ] 30s master (1080p, narrated)
- [ ] 30s master (1080p, silent — just overlays)
- [ ] 10s cut (1080p, silent) — for Twitter autoplay
- [ ] Looping 6s GIF from Shot 3 (cache hit) — for landing hero
- [ ] Static hero image (2048×1024) — Shot 6 frame — for OG tags
- [ ] Transcript (for accessibility + SEO)

---

## Why this script

**Old script problems (V1):**
- Required Claude Desktop + MCP server setup (extra 30 min of pre-prod)
- Showed generic APIs (SerpAPI, Firecrawl), no differentiator
- Narration felt generic ("every paid API your agent needs")

**New script wins (V2):**
- Opens with the **only unique claim Axon can make**: native Brazilian data
- Uses the **real live API**, real key, real traffic — no mockups
- Cache hit is shown numerically (fast to slow timer = visceral proof of savings)
- Ends with BR flag + São Paulo — humanizes the project
- All shots are **gravable em terminal + navegador**. No extra tooling.
