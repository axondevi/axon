-- Track which agent (if any) drove each upstream request so /v1/agents/:id/analytics
-- can aggregate calls / cost / tool breakdown per agent.

ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "agent_id" uuid;
CREATE INDEX IF NOT EXISTS "req_agent_idx" ON "requests" ("agent_id");
