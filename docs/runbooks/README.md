# Runbooks

Incident response references. Each one should answer "what's broken,
how do I confirm it, how do I fix it, how do I verify recovery,
what do I write up after."

| Runbook | When to read |
|---|---|
| [recovery.md](recovery.md) | Data corruption / restore from snapshot |
| [redis-outage.md](redis-outage.md) | Rate limiter, budget reservation, replay-guard down |
| [postgres-outage.md](postgres-outage.md) | DB unreachable or schema drift |
| [elevenlabs-banned.md](elevenlabs-banned.md) | Voice TTS returns 402 / 401 |
| [whatsapp-disconnected.md](whatsapp-disconnected.md) | Specific agent stops replying |
| [balance-drift.md](balance-drift.md) | wallets.balance ≠ SUM(transactions) |

## Drill schedule

Quarterly drill: pick one runbook, follow it end-to-end on a
non-prod target (Neon branch, separate Render preview env). Time
the round-trip; update the runbook if any step was ambiguous.

Update the "last drilled" line at the top of the runbook each time.

## Adding a new runbook

Create `docs/runbooks/<topic>.md` with these sections:

1. **Symptoms** — what an operator sees that triggers them to read
   this doc
2. **Quick check** — 1-2 commands to confirm
3. **Decision tree / Mitigations** — ordered by likelihood × effort
4. **What still works / What is broken** — set expectations
5. **Recovery verification** — proof you're back
6. **Postmortem checklist** — what to capture

Then add a row to the table above and to the list in
`SECURITY.md` if the incident touches a security boundary.
