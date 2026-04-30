-- Pause + Human handoff (kill the AI talking over the human)
--
-- Two independent muting controls that the WhatsApp webhook receiver
-- consults before invoking the agent:
--
--   agents.paused_at — global pause set by the owner from the dashboard.
--                      All inbound for this agent is dropped (returns
--                      ignored:'paused') until the owner unpauses.
--                      Connection stays alive; just the AI is muted.
--
--   contact_memory.human_paused_until — per-contact mute, automatic.
--                      Set when the owner replies manually from their
--                      phone (we detect it via Evolution's fromMe webhook
--                      events for messages we did NOT send). Lasts 30
--                      minutes by default, gives the human time to
--                      handle the conversation. Cleared automatically
--                      once the timestamp passes.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS paused_at timestamp;

ALTER TABLE contact_memory
  ADD COLUMN IF NOT EXISTS human_paused_until timestamp;
