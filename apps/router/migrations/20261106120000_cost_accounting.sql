ALTER TABLE calls ADD COLUMN or_cost_micros INTEGER;
ALTER TABLE calls ADD COLUMN upstream_cost_micros INTEGER;
ALTER TABLE calls ADD COLUMN estimated_cost_micros INTEGER;
ALTER TABLE calls ADD COLUMN is_byok INTEGER;
ALTER TABLE calls ADD COLUMN upstream_provider TEXT;
ALTER TABLE calls ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls ADD COLUMN trimmed_from_tokens INTEGER;

ALTER TABLE decisions ADD COLUMN or_cost_micros INTEGER;
ALTER TABLE decisions ADD COLUMN upstream_cost_micros INTEGER;
ALTER TABLE decisions ADD COLUMN estimated_cost_micros INTEGER;
ALTER TABLE decisions ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'none';
