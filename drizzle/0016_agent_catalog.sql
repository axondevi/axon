-- Catalog: structured inventory the agent uses as source of truth.
-- Stored as JSONB on the agent row (single round trip on hot path,
-- supports up to ~500 items comfortably; bigger catalogs would
-- migrate to a dedicated table later). Owner uploads CSV/JSON via
-- POST /v1/agents/:id/catalog/upload — backend normalizes shape.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS catalog jsonb;
