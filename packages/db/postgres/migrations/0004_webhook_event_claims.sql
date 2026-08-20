-- LINE webhook at-most-once guard (#49).
-- Mirrors packages/db/migrations/053_webhook_event_claims.sql (D1). Every
-- statement is idempotent so re-application is a no-op.
CREATE TABLE IF NOT EXISTS webhook_event_claims (
  webhook_event_id TEXT PRIMARY KEY,
  claimed_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_event_claims_expires ON webhook_event_claims (expires_at);
