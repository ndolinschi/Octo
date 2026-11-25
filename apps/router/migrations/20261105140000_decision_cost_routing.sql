ALTER TABLE decisions ADD COLUMN cost_micros INTEGER;
ALTER TABLE calls ADD COLUMN tier_before TEXT;
ALTER TABLE calls ADD COLUMN tier_after TEXT;
ALTER TABLE calls ADD COLUMN trigger TEXT NOT NULL DEFAULT 'none';
ALTER TABLE calls ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS calls_session_id ON calls(session_id);
