# Demo Video — 30 seconds

Goal: someone who's never heard of Axon understands what it does in 30 seconds. Shared on Twitter/X, embedded on the landing hero, pinned in Product Hunt gallery.

**Total length: 30s · 8 shots · ~50 words of narration**

---

## Shot list

### Shot 1 · 0.0 – 3.0s · COLD OPEN
**Visual:** Terminal. Dark theme. Someone types:

```
npx @axon/mcp-server
```

and hits enter. A confirmation line appears:

```
axon-mcp ready (stdio transport)
```

**Narration:**
> "Your AI agent needs to buy things. Here's how."

**On-screen text (corner):** `0:01 · Axon`

---

### Shot 2 · 3.0 – 6.0s · CLAUDE DESKTOP
**Visual:** Claude Desktop window opens. A chat starts with a user prompt:

> Find me the 3 best espresso bars in Lisbon with reviews.

The tools tray on the side now shows `serpapi__search`, `firecrawl__scrape`, `openai__chat` — all marked "Axon".

**Narration:**
> "Every paid API your agent needs — one endpoint, one wallet."

---

### Shot 3 · 6.0 – 9.0s · AGENT IS WORKING
**Visual:** Claude's "using tools" indicator. Speed-run timelapse showing 4 tool calls happening. On each, a tiny HUD pops up showing `-$0.0055 USDC`, `-$0.0045 USDC`, etc.

**Narration:**
> "Pays in USDC, per request."

---

### Shot 4 · 9.0 – 13.0s · RESULT
**Visual:** Claude's answer streams in — "1. Copenhagen Coffee Lab — reliably excellent beans…" — with source links.

**Narration:**
> "No API key management. No monthly subscriptions. No human in the loop."

---

### Shot 5 · 13.0 – 17.0s · THE WALLET
**Visual:** Cut to Axon dashboard. Balance: `24.973 USDC`. Recent transactions showing 4 small debits in red. Cache hit rate: `31%`.

**Narration:**
> "Every call is accounted for. Cached responses cost 50% less."

---

### Shot 6 · 17.0 – 21.0s · CATALOG
**Visual:** Logo wall / grid of 17 API names scrolling into view — OpenAI, Anthropic, SerpAPI, Firecrawl, Exa, Tavily, ElevenLabs, Deepgram, Apollo, IPinfo, Voyage, Mindee, DeepL, Stability, Together, Replicate, OpenWeather.

**Narration:**
> "17 APIs live. 5 more every week."

---

### Shot 7 · 21.0 – 26.0s · HOW TO START
**Visual:** Code snippet, clean and minimal:

```ts
import { Axon } from '@axon/client';
const axon = new Axon({ apiKey: process.env.AXON_KEY });
await axon.call('serpapi', 'search', { q: 'hello' });
```

**Narration:**
> "Three lines of code. Free to start."

---

### Shot 8 · 26.0 – 30.0s · CLOSE
**Visual:** Full-screen logo + URL.

> **axon** — payment rails for the agent economy
> **axon.dev** · $5 free to start

**Narration:** *(silence — let the logo land)*

---

## Production notes

- **Screen recording tool:** Use [OBS](https://obsproject.com/) at 2560×1440, export to 1080p for Twitter, keep 2560 master for embeds
- **Terminal font:** JetBrains Mono 16pt, theme = Axon's dark palette (`#0a0a0b` bg, `#19d5c6` accent)
- **Narration:** Record with any decent USB mic. If you don't want to narrate, the visuals + on-screen text carry it silently
- **Music:** Optional. Low-fi ambient works. [Epidemic Sound](https://epidemicsound.com) or [pixabay.com/music](https://pixabay.com/music)

## Alt: 10-second ultra-short (for "raw" Twitter post)

Same storyline, 3 shots:
1. (3s) MCP install in Claude Desktop
2. (4s) Agent runs, HUD shows 4 micro-debits
3. (3s) Logo + "axon.dev — $5 free"

## Alt: 90-second long-form (for the landing hero)

Everything above + a "behind the scenes" mid-section showing:
- The cache hit serving (0.003 USDC, 40ms)
- The refund when upstream returns 500
- The wallet balance before/after

Length matters less for embedded video than for social — but never make people wait more than 5 seconds before showing something useful.

## Assets checklist

- [ ] 30s master (1080p, silent)
- [ ] 30s master (1080p, narrated)
- [ ] 10s cut (1080p, silent) — for Twitter autoplay
- [ ] Looping 6s GIF from shot 3 — for landing hero
- [ ] Static hero image (2048×1024) — shot 8 frame — for OG tags
- [ ] Transcript (for accessibility + SEO)
