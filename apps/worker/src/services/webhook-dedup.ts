// At-most-once claim store for LINE webhook events (#49).
//
// LINE redelivers a webhook when our ACK is slow or fails. Without a claim the
// same event runs the whole handler again — including the AI turn — so the
// friend gets a duplicate replyMessage / pushMessage. Claiming the
// `webhookEventId` before processing makes each delivered event run once.
//
// Mirrors the booking Idempotency-Key store: PK + ON CONFLICT DO NOTHING, with
// expired rows purged on the 6h cron tick so the table stays bounded.
//
// Unlike the booking store this is NOT scoped by line_account_id: LINE mints
// webhookEventId globally, so an id can only ever belong to one account and a
// global lookup leaks nothing across tenants.

// LINE retries within minutes; a day of history is far more than the retry
// window needs and keeps the table small.
const CLAIM_TTL_HOURS = 24;

/**
 * Claim a webhook event id. Returns true when this call won the claim (first
 * time we have seen the id), false when the id was already claimed and the
 * event should be skipped.
 *
 * Fails open (true) if the backend reports no `meta.changes`: dropping live
 * traffic is worse than the duplicate this guard exists to prevent.
 */
export async function claimWebhookEvent(
  db: D1Database,
  webhookEventId: string,
  now: Date,
): Promise<boolean> {
  const expires = new Date(now.getTime() + CLAIM_TTL_HOURS * 60 * 60_000).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO webhook_event_claims (webhook_event_id, claimed_at, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(webhook_event_id) DO NOTHING`,
    )
    .bind(webhookEventId, now.toISOString(), expires)
    .run();

  const changes = result?.meta?.changes;
  if (typeof changes !== 'number') return true;
  return changes > 0;
}

/**
 * Drop a claim so LINE's next redelivery of the same event can process it.
 * Called when the handler threw: keeping the claim would turn a transient
 * failure into a permanently lost customer message.
 */
export async function releaseWebhookEvent(db: D1Database, webhookEventId: string): Promise<void> {
  await db
    .prepare('DELETE FROM webhook_event_claims WHERE webhook_event_id = ?')
    .bind(webhookEventId)
    .run();
}

/** Delete claims past their TTL. Returns the number of rows removed. */
export async function purgeExpiredWebhookEvents(db: D1Database, now: Date): Promise<number> {
  const result = await db
    .prepare('DELETE FROM webhook_event_claims WHERE expires_at <= ?')
    .bind(now.toISOString())
    .run();
  return result?.meta?.changes ?? 0;
}
