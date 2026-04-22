## What this changes

One sentence. Skip if the title already says it.

## Why

The reason behind the change. If it fixes a bug, link the issue. If it's a new feature, link the discussion or explain the use case.

## How I tested it

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] Manual test: describe what you clicked/curled/ran

If this touches money (wallet, debit, refund, settlement, policy) — **confirm** you added a test covering the new path.

## Screenshots / logs (if relevant)

Paste anything that helps the reviewer understand the effect.

## Checklist

- [ ] I read `CONTRIBUTING.md`
- [ ] I did **not** add new dependencies without explaining why below
- [ ] I did **not** use `any` without a comment explaining why
- [ ] If I added an env var, it's documented in `.env.example` and `src/config.ts`
- [ ] If I added a new registry entry, I verified it parses (`jq . registry/*.json`)

## Dependencies added (if any)

- `pkg@version` — reason
