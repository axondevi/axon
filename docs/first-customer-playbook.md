# First customer playbook

The path from "the product is deployed" to "someone paid us" at zero capital.

This doc is the direct, unglamorous plan. Not theory. Not "build in public for 6 months hoping it compounds." What to do tomorrow.

---

## The goal

Get **one** real person to:

1. Sign up
2. Deposit $5+ in USDC on Base
3. Make at least 10 API calls through Axon

If that happens, you have proof the product works end-to-end with real money. Everything else (10 users, 100, 1000) is iteration on the same playbook.

**Target timeline: 14 days from deployment.**

---

## Why not "viral launch"

Three reasons we don't start with a big Twitter thread / HN / Product Hunt:

1. **You have no evidence yet.** The landing claims 17+ APIs and auto-refunds and cache discounts — none of which a reader can verify without signing up. First real user → first tweet with numbers.
2. **Feedback loop is broken at scale.** 500 signups and 0 conversions tells you nothing actionable. 5 signups where you personally talked to 5 people tells you what to fix.
3. **You can't support a viral moment on free tier.** Render free tier spins down after 15min of idle. A 100-visit HN spike = cold starts for everyone. Pointless.

Launch big **after** you have ~10 paying users. The HN post "How we built x402 payment rails, first month in review" will land much better than "we launched a thing."

---

## The 5-signup sprint (week 1)

Not 500. Five. Hand-deliver each one.

### Day 1 — Make the list

Open a note / spreadsheet. Write down 20 names. Any of these sources work:

- People you follow on Twitter who build AI agents (check their last 30 tweets — are they shipping?)
- Contributors on LangChain / crewAI / Autogen GitHub repos in the last 30 days
- Active members in the LangChain Discord, Latent Space Slack, Vercel AI SDK Discord
- Active posters in r/LocalLLaMA, r/AIAgents (look at "top of this week")
- Every "building an AI agent for X" bio you can find

**Criteria**: they're actively shipping agent code *right now*. Not "interested in AI." Past-tense builders don't convert to users of an alpha product.

### Day 2 — Reach out

Send each one this message (in whatever channel they're active in — DM, email, Discord):

```
Hey [name],

Saw your [specific thing they built or tweeted]. I'm building
Axon — a gateway that lets AI agents pay for any paid API via
one USDC wallet instead of juggling 20 API keys.

Would it unblock anything you're working on? Happy to set you
up with $5 in credit + personal onboarding, no strings.

[your name]
[link: 30-second demo video, NOT the landing page]
```

Customize the first line per person. Mass messages read as mass messages. One-line personalization is worth 10× the reply rate.

### Day 3-5 — Respond to every reply

Every reply is a conversation, not a transaction. The goal is:

1. Understand their agent / use case in 2-3 questions
2. Hand them a working API key + $5 deposit
3. Watch them make their first call (ideally over a screenshare)
4. Note every friction point

If they get stuck: fix it the same day. Redeploy in 1 hour. Tell them "it's fixed, try again." This loop is your entire moat in the early days.

### Day 6 — Inventory

Open the note you started on day 1. Tally:

- Sent DMs: __
- Got replies: __
- Got signups: __
- Made at least 1 call: __
- Would they use it next week? __ (ask directly)

If 0 signups in 6 days, something is broken in the pitch or the product. Don't keep sending DMs. Figure out what's wrong.

If 2-5 signups: you're on track. Keep going.

---

## Week 2 — First conversion

You have 2-5 users from week 1 with free $5 credit. Goal this week:

**One of them deposits real USDC.**

How to nudge without being pushy:

### The email (send 48h after they used their free $5)

```
Subject: Your $5 axon credit ran out — want to top up?

Hey [name],

You used $[X] on [specific thing they did] — [cite a nice result
if you saw one, e.g. "the agent got through 3 scrapes and
summarized them cleanly"].

If you want to keep going, deposit at: [their deposit address
from /v1/wallet/deposit-intent]

$5-10 in USDC on Base covers ~1000 more calls at your current
pattern. Happy to send you a Base faucet link if you haven't
used USDC before.

Any feedback, anything broken, anything missing — just reply.
```

Some will deposit. Some won't. The ones who don't tell you more than the ones who do:

- "I don't have USDC" → write them a USDC-on-Base explainer
- "Too early, I'm still evaluating" → ask what evidence they'd need
- Silence → the product didn't hook them. Ask why.

---

## Week 3-4 — Compound

Three things stack now:

### 1. Public-facing evidence

For every user who did something interesting, ask permission to tweet:

```
[Name] at [project] built [thing] using Axon this week. 4 paid APIs,
one wallet, $0.07 total. Their stack: [tools].
```

Specifics convert. Vague launches don't.

### 2. Case study / blog post

One long-form post when you hit 10 users. Title:

```
10 AI agents paid for their own APIs this month. Here's what they
bought and how much it cost.
```

Publish on your own blog, syndicate to HN + Dev.to + relevant subreddits. This is shareable because it's *data*, not pitch.

### 3. The referral mechanic (organic, not paid)

Add to every onboarding email:

```
P.S. If you pass Axon to another builder and they sign up,
we'll add $10 to each of your wallets. No tracking codes —
just DM me.
```

At early stage, manual tracking is fine. Scale this later if it works.

---

## When you DO post on HN / Twitter / PH

After 10 users, at least 3 paying, at least 2 active weekly.

Use `marketing/twitter-launch-thread.md` and `marketing/hn-show-post.md`. Both are written assuming you have real numbers to plug in.

The key change from the template: replace all placeholder stats with your actual numbers.

---

## What kills this playbook

- **Not talking to users**. If week 1 ends with 0 conversations, you failed week 1 regardless of how many DMs went out.
- **Fixing imaginary bugs**. You'll be tempted to add features before your first user asks for them. Don't. Every hour before your first user that isn't spent acquiring your first user is wasted.
- **Mass blast anything**. Personalization is the entire game at this stage.
- **Hiding behind the landing page**. Your landing is not your product. The product is you personally setting someone up and watching their agent work.

---

## A realistic baseline

If you do this playbook for 3-4 weeks with reasonable consistency:

| Week | Signups | Paying | MRR |
|------|---------|--------|-----|
| 1    | 2-5     | 0      | $0 |
| 2    | 5-10    | 1-2    | $10-30 |
| 3    | 10-20   | 3-5    | $50-100 |
| 4    | 20-40   | 5-10   | $100-250 |

Those numbers look small. They're fine. The point of the first month is to prove the loop, not to hit a target.

Once the loop is proven, you scale it. Same playbook, 20× the volume.

---

## The one metric that matters

Not MRR. Not signups. Not even deposits.

**The number of users who made an API call in the last 7 days.**

If that number is growing week-over-week, you're winning. If it's flat or shrinking, nothing else matters — stop and talk to the users who drifted away.
