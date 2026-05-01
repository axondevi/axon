-- Per-agent free-text business info (address, hours, prices, insurance,
-- specialties...) that the owner fills in via the /build form. Injected
-- into the LLM system_prompt at runtime so updates take effect on the
-- next inbound without redeploying or rebuilding the agent.
--
-- Why a separate column instead of cramming into system_prompt: keeps
-- the prompt template stable and lets the owner edit a focused field
-- in the dashboard ("Informações importantes do seu negócio") without
-- the risk of accidentally breaking the prompt structure.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS business_info text;
