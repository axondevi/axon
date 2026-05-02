# Wallet balance drift

The ledger is the source of truth. If `wallets.balance_micro` doesn't
equal `SUM(transactions.amount_micro)` for a user, something went
wrong. This runbook walks the diagnosis.

## Symptoms

- A user reports their balance dropped without a corresponding chat
  or charge.
- Internal monitor flags drift on the operator dashboard.
- `bun run scripts/balance-audit.ts` (you'll add this when needed)
  reports a delta.

## The query

```sql
SELECT
  w.user_id,
  w.balance_micro                                  AS wallet_balance,
  COALESCE(SUM(t.amount_micro), 0)::bigint         AS ledger_sum,
  w.balance_micro - COALESCE(SUM(t.amount_micro), 0)::bigint AS drift_micro
FROM wallets w
LEFT JOIN transactions t ON t.user_id = w.user_id
GROUP BY w.user_id, w.balance_micro
HAVING w.balance_micro <> COALESCE(SUM(t.amount_micro), 0)::bigint
ORDER BY ABS(w.balance_micro - COALESCE(SUM(t.amount_micro), 0)::bigint) DESC
LIMIT 20;
```

Run via `psql` against the prod DATABASE_URL.

## Common causes (and fixes)

### 1. Replayed onchain webhook
A prior bug let a re-delivered Alchemy/MP webhook credit twice.
Today the ledger row INSERT happens FIRST when `onchain_tx` is set,
so a duplicate raises the unique partial index — see
`src/wallet/service.ts:credit`. If drift exists for old rows from
before the fix:

```sql
-- Find duplicate-credit candidates
SELECT user_id, type, amount_micro, onchain_tx, COUNT(*) AS n
FROM transactions
WHERE onchain_tx IS NOT NULL
GROUP BY user_id, type, amount_micro, onchain_tx
HAVING COUNT(*) > 1;
```

For each duplicate, delete the extra row and adjust the wallet:

```sql
-- Decide which transaction to KEEP (oldest is usually right)
-- and DELETE the rest. Then:
UPDATE wallets
SET balance_micro = balance_micro - <duplicate_amount>
WHERE user_id = '<id>';

-- Audit it
INSERT INTO admin_audit_log (action, target_user_id, actor_admin_key, meta)
VALUES ('admin.wallet.drift_fix', '<id>', true, '{"removed_tx_ids": [...], "amount_micro": "..."}'::jsonb);
```

### 2. Failed refund that left the wallet debited
If `refund()` is called from `wrapper/engine.ts` and Postgres rejects
the `credit()` for any reason, the user got debited but never refunded.

Verify by joining `requests` (status >= 400) with `transactions`
(type='refund'):

```sql
SELECT r.id, r.user_id, r.cost_micro, r.markup_micro, r.status
FROM requests r
LEFT JOIN transactions t ON t.user_id = r.user_id
                          AND t.meta->>'reason' LIKE 'upstream_%'
                          AND t.created_at >= r.created_at - INTERVAL '5 minutes'
                          AND t.created_at <= r.created_at + INTERVAL '5 minutes'
WHERE r.status >= 400 AND t.id IS NULL
LIMIT 50;
```

Fix manually:

```sql
INSERT INTO transactions (user_id, type, amount_micro, api_slug, meta)
VALUES ('<user>', 'refund', <cost+markup>, '<api>', '{"reason":"manual_drift_fix"}'::jsonb);
UPDATE wallets SET balance_micro = balance_micro + <amount> WHERE user_id = '<user>';
```

Audit log it.

### 3. Manual SQL gone wrong
Someone ran a one-off UPDATE on `wallets` without a matching
`transactions` row. Search audit log:

```bash
curl -H "x-admin-key: $ADMIN_API_KEY" \
  "https://axon-kedb.onrender.com/v1/admin/audit?action=admin.credit"
```

Reconcile by inserting the matching ledger entry.

## Prevention

- Never UPDATE wallets directly. Always go through
  `src/wallet/service.ts` so the matching transaction is written.
- The ledger insert + balance UPDATE is atomic per call (single
  pg.Pool query in a transaction wrapper for all credit paths).
- The `tx_onchain_idx` unique partial index prevents replay double-
  credit at the database level.

## Verification

Re-run the drift query — should return zero rows.

```sql
SELECT COUNT(*) AS drift_users FROM (
  SELECT 1 FROM wallets w
  LEFT JOIN transactions t USING (user_id)
  GROUP BY w.user_id, w.balance_micro
  HAVING w.balance_micro <> COALESCE(SUM(t.amount_micro), 0)::bigint
) sub;
-- Expected: 0
```

Add the result to `admin_audit_log`:

```sql
INSERT INTO admin_audit_log (action, actor_admin_key, meta)
VALUES ('admin.wallet.drift_audit', true,
        jsonb_build_object('drift_users', 0, 'scanned_at', NOW()));
```
