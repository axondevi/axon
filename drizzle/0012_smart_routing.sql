-- Smart routing: an agent can act as a "router" that classifies the customer's
-- intent (sales / personal / support) on the first turn and dispatches the
-- conversation to a more specialized agent. The routing is sticky per contact
-- via contact_memory.routed_agent_id so we don't reclassify every turn.
--
-- Schema design:
--   agents.routes_to        jsonb { sales?: uuid, personal?: uuid, support?: uuid }
--                           Owner sets this on the "router agent" they want to use
--                           as the public-facing entry point. Each value points
--                           to another agent owned by the same user. NULL on a
--                           leaf agent (the routed-to one).
--   contact_memory.routed_agent_id uuid
--                           Once classified, every subsequent turn from this
--                           contact uses the routed agent's prompt/tools/persona
--                           DIRECTLY. To re-classify (e.g. customer pivots from
--                           sales to support), the agent calls a `reset_route`
--                           tool — outside the scope of this migration.
--   contact_memory.route_intent text
--                           The classification verdict ('sales' | 'personal' |
--                           'support' | 'unknown'). Kept separate from
--                           routed_agent_id so we can audit or re-route without
--                           losing the original classification.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS routes_to jsonb;

ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS routed_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS route_intent text;

CREATE INDEX IF NOT EXISTS contact_memory_routed_agent_idx
  ON contact_memory (routed_agent_id);
