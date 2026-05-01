# Waitlist + Onboarding Emails

Subject lines matter more than body. Test two per email.

---

## Email 1 — Confirmation (sent immediately)

**Subject A:** `You're in. Here's what happens next.`
**Subject B:** `Axon early access: confirmed`

> Hi —
>
> You're on the Axon early-access list. Here's the deal:
>
> We're onboarding the first 100 builders personally. If you tell me what you're building, I'll move you to the front of the line and credit your wallet with $25 in USDC when it opens.
>
> Just hit reply with 2-3 sentences:
> 1. What are you building?
> 2. Which paid APIs does your agent (or flow) need?
> 3. What's one thing that would make Axon an instant "yes" for you?
>
> I read every reply myself.
>
> — [Your name], founder
>
> P.S. No newsletter, no drip, no nonsense. You'll only hear from me when there's something real to ship.

---

## Email 2 — Access granted (sent when they're activated)

**Subject A:** `Your Axon wallet is live + $25 loaded`
**Subject B:** `You're activated — here's your first request`

> You're in.
>
> Your API key: `ax_live_XXXXXXXXXXXX`
> Your deposit address: `0xYYYYYYYY…`
> Starting balance: $25.00 USDC (on us)
>
> Your first request — literally paste into a terminal:
>
>     curl https://axon-kedb.onrender.com/v1/call/serpapi/search?q=hello \
>       -H "x-api-key: ax_live_XXXXXXXXXXXX"
>
> You'll see the response, the cost it took from your wallet, and whether it was cached. That's all there is.
>
> **When you hit a problem** — reply to this email. Not a form. Not a ticket queue. My inbox.
>
> **When something works** — tell me that too. I'm building a list of use cases to share (with permission).
>
> — [Your name]

---

## Email 3 — Day 7 nudge (only if no API call logged)

**Subject A:** `Stuck somewhere in Axon?`
**Subject B:** `Can I unblock you?`

> Hey — noticed your account is set up but hasn't made a call yet. That's almost always one of these:
>
> 1. Waiting on a specific API that isn't in the catalog yet → tell me which one, I'll prioritize
> 2. Not sure how to plug it into your framework → reply with your stack, I'll send a snippet
> 3. Still evaluating whether this fits → I'd rather hear a "not yet" than silence, so I know what to fix
>
> Whatever it is, hit reply. Ten words is enough.
>
> — [Your name]

---

## Email 4 — First call landed (triggered)

**Subject:** `First request shipped. Here's what's next.`

> Your agent just made its first paid call through Axon. That's officially a real agent now.
>
> Three things that unlock more mileage:
>
> 1. **Check the catalog weekly** — we add 5+ APIs a week, and the more you wire up, the more compounded the value. [Catalog →]
> 2. **Turn on analytics** — free on Pro. Shows cache-hit rate, spend per API, and latency per endpoint. Helps you optimize which APIs to lean on.
> 3. **Tell me what's missing.** What tool did you wish you could wire up last week and couldn't? Reply and I'll tell you when it ships.
>
> — [Your name]

---

## Email 5 — Monthly update (once you have volume)

**Subject:** `What shipped in Axon — {{month}}`

> **New APIs:** [list]
> **Improvements:** [list]
> **Community builds:** [highlight 1-2 agents built on Axon with permission]
> **Your stats:** {{requests}} calls · {{cache_hit_rate}}% cache hit rate · {{spent_usdc}} spent
>
> What we're building next (and want feedback on): [ask 1 specific question, 1 link]
>
> — [Your name]

---

## Unsubscribe footer (all emails)

> You got this because you signed up at axon.dev. One-click unsubscribe: [link]. No segmentation tricks, no re-adding you. When you're out, you're out.
