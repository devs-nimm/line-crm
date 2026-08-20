-- LINE webhook at-most-once guard (#49).
-- LINE redelivers a webhook when the ACK is slow or fails, which re-ran the
-- whole handler — including the AI turn — and duplicated reply/push sends.
-- Claims are purged past expires_at on the 6h cron tick.
CREATE TABLE IF NOT EXISTS webhook_event_claims (
  webhook_event_id TEXT PRIMARY KEY,
  claimed_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_event_claims_expires ON webhook_event_claims (expires_at);
