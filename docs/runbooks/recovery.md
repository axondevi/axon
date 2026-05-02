# Recovery runbook

How to recover from data loss or a corrupted database. Last exercised: **(record date here after every drill)**.

## RPO / RTO targets

- **RPO (Recovery Point Objective):** ≤ 24 hours of data loss tolerated.
- **RTO (Recovery Time Objective):** ≤ 2 hours from incident start to service restored.

Both targets are met by Neon's continuous WAL backups + `bun run scripts/backup-verify.ts`.

---

## Continuous health check

`scripts/backup-verify.ts` is the single source of truth for "is the
database healthy and is recent activity flowing?" It checks:

1. Liveness (`SELECT 1`)
2. Every critical table exists and has the expected row floor
3. Latest `requests.created_at` is within RPO (24h)
4. Schema has every column that migrations 0009-0019 should have added

Run it locally against prod:

```bash
DATABASE_URL='postgres://…' bun run scripts/backup-verify.ts
```

Exit 0 + green output = healthy.
Exit 1 = at least one check failed; see the JSON output for which.

CI runs it weekly via `.github/workflows/backup-verify.yml`. If a run
fails, the workflow goes red — investigate immediately.

---

## Restore from Neon snapshot

Neon keeps continuous WAL for the last 7 days (free tier) or 30 days
(paid). Steps:

1. **Identify the moment of corruption.** Check `admin_audit_log`,
   `requests` timestamps, last good deploy. Pick a target timestamp
   that's BEFORE the corruption.

2. **Create a branch from that timestamp** in the Neon console:
   - Project → Branches → New branch
   - Source: `main`
   - Restore point: pick the timestamp
   - Name it: `restore-YYYY-MM-DD-HHMM`

3. **Get the new DATABASE_URL.** Neon shows it on the new branch
   page. Test it before swapping prod:

   ```bash
   DATABASE_URL='postgres://…<restore-branch>…' bun run scripts/backup-verify.ts
   ```

   Should return `ok: true` with a recent-but-not-latest
   `last_request`.

4. **Swap the prod env var.** In Render dashboard:
   - Service → Environment → Edit `DATABASE_URL`
   - Paste the restored URL
   - Save (triggers redeploy)

   Or via API:
   ```bash
   curl -X PUT \
     -H "Authorization: Bearer $RENDER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"value":"<new-url>"}' \
     "https://api.render.com/v1/services/$SERVICE_ID/env-vars/DATABASE_URL"
   ```

5. **Verify recovery.** Once Render redeploys (≤4min):

   ```bash
   curl https://axon-kedb.onrender.com/health/ready
   # → {"status":"ready"}

   bun run scripts/backup-verify.ts  # against the new prod URL
   ```

6. **Promote the branch** (optional but recommended). Once you're
   confident the restored data is correct, in Neon:
   - Branches → `restore-…` → Set as primary
   - Old `main` branch becomes the failed copy, keep for 7d in case
     of confusion, then delete.

7. **Audit the gap.** Anything between the restore timestamp and
   the corruption is gone. Notify affected users:
   - Query `admin_audit_log` for the gap window — what privileged
     actions ran and need to be redone manually?
   - Re-derive `wallets.balance_micro` from `transactions` aggregates
     to spot drift if needed.

8. **Run a postmortem.** Update this runbook with anything that was
   ambiguous or slow. Update the "last exercised" date at the top.

---

## Drill quarterly

Production won't break the day you actually need this — it'll break
in the middle of something else. Do a quarterly drill:

1. Branch prod in Neon to `drill-YYYY-MM`
2. Run `backup-verify.ts` against the branch — should pass
3. Practice swapping `DATABASE_URL` on a staging service (NOT prod)
4. Time the round trip; if > RTO, simplify
5. Delete the drill branch

Add a calendar reminder so this doesn't slip.
