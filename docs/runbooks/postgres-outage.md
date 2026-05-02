# Postgres outage

## Symptoms

- `/health/ready` returns 503.
- Most authed endpoints return 500 with `internal` error code.
- Render logs filled with `error: Connection terminated unexpectedly`
  or `pg.Pool` timeouts.
- `bun run scripts/backup-verify.ts` exits non-zero with `liveness`
  failed.

## Quick check

```bash
# Run backup-verify — first check is liveness
DATABASE_URL='postgres://…' bun run scripts/backup-verify.ts | head -20
```

## Decision tree

### A. Connection issue (URL or credentials)
Most common. Symptoms: connection times out or auth fails immediately.

1. Compare prod `DATABASE_URL` env in Render to the URL shown in Neon
   console for the active branch.
2. If they differ: someone rotated the password or branched the DB.
   Update Render env and redeploy.

### B. Neon-side incident
Check https://status.neon.tech.

- **If Neon is degraded:** wait + monitor; cannot mitigate locally.
- **If our project specifically is down:** Neon support ticket. While
  waiting, follow `recovery.md` to branch from a recent restore point
  if data integrity is suspect.

### C. Schema mismatch (deploy regression)
Symptoms: `column "X" does not exist` errors. Means a migration
rolled back or `db:migrate` didn't run on the latest deploy.

Bootstrap.ts has a self-heal block that runs on every boot — usually
the next deploy fixes it. If not:

```bash
DATABASE_URL='postgres://…' bun run db:push  # syncs schema directly
```

### D. Resource exhaustion (connections / disk)
- pg.Pool max=10 in our config; Neon free tier allows 100 connections.
- If we hit it, render logs show `too many clients already`. Restart
  the service (Render → Manual Deploy) to drop stale connections.

## What still works

- `/health` (no DB)
- `/v1/personas/*/avatar.svg` — procedural, no DB
- WhatsApp inbound webhook returns 200 (logs get queued, replies fail)

## What is broken

- All authed endpoints
- Catalog listings (`/v1/apis` reads from registry/, but the route
  hits DB for billing — verify)
- Webhooks (signature verification works, but state changes fail)

## Recovery verification

```bash
curl https://axon-kedb.onrender.com/health/ready
# {"status":"ready"}

bun run scripts/backup-verify.ts
# all green
```

## Postmortem checklist

- [ ] Confirm wallet balances haven't drifted vs `transactions`
      aggregate
- [ ] Check `requests` table for missing rows (compare upstream
      provider invoice for the period)
- [ ] If we restored from snapshot, check `admin_audit_log` gap
