# Contributing to Axon

Thanks for your interest. This is a small, fast-moving project — contributions that improve reliability, expand the API catalog, or make the developer experience better are especially welcome.

## The short version

1. Fork, branch (`feat/<short-name>` or `fix/<short-name>`), commit, PR.
2. `bun test` and `bun run typecheck` must pass.
3. For new APIs in the catalog, a single JSON file in `registry/` is enough — no code changes usually needed.
4. For changes to pricing, debit flow, or wallet: include a test. These paths handle real money.

## What's easy to accept

- **New API in the catalog.** Drop a JSON in `registry/`. If it follows the pattern in `docs/adding-apis.md` and has a reasonable cache TTL, it gets merged.
- **Bug fixes with a test.** If the test reproduces the bug before the fix and passes after, the PR almost always lands.
- **Documentation fixes.** Typos, clarifications, broken links.
- **New framework integrations** following the pattern in `integrations/`.

## What needs discussion first

Open an issue before doing the work:

- Schema changes (Drizzle migrations)
- Changes to the wallet service (debit/credit/refund logic)
- Changes to the payment flow (prepaid + x402 native)
- Anything that affects settlement

These touch money. We'd rather discuss the design before you write code.

## What we generally won't accept

- Dependencies added without a clear reason. We want the server to boot in <1s.
- Code that uses floats for money amounts. `bigint` micro-USDC only.
- New dashboards/UIs in the main repo. They belong in separate projects.
- Premature abstractions — "in case we need X later." If we don't need X now, the code doesn't have X.

## Code style

- TypeScript, no `any` unless there's a reason (JSON payloads from unknown shape)
- Functions do one thing
- Comments explain *why*, not *what*. If you need a comment to explain what the code does, the code probably needs to be clearer.
- Commits: imperative present tense ("add brave search", not "added" or "adds")

## Running locally

```bash
bun install
cp .env.example .env
docker compose up -d   # Postgres + Redis
bun run db:push
bun run seed
bun run dev
```

Hit `http://localhost:3000/health` — if you get `{"status":"ok"}` you're good.

## Tests

```bash
bun test            # unit + integration
bun run typecheck   # TypeScript
```

Integration tests stub DB and Redis — no live services required.

## Reviewing your own PR before asking for review

1. Does the diff do only what the PR title says? Remove unrelated changes.
2. Have you run the test suite?
3. If you changed `wrapper/engine.ts`, `policy/`, `wallet/`, or `settlement/`: does a test cover the new behavior?
4. If you added a dependency: explain why in the PR description.

## Release process

Maintainer-only for now. We tag releases on merge to `main` when a set of changes feels coherent.

## Questions?

Open a discussion, not an issue, if you're not sure whether a change is wanted. We read everything.
