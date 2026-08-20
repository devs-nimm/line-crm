import { describe, expect, test, vi } from 'vitest';
import { claimWebhookEvent, purgeExpiredWebhookEvents } from './webhook-dedup.js';

function stubDb(runResult: unknown) {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue(runResult),
  };
  stmt.bind.mockReturnValue(stmt);
  const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
  return { db, stmt };
}

const NOW = new Date('2026-06-18T03:00:00.000Z');

describe('claimWebhookEvent', () => {
  test('returns true when the row is newly inserted', async () => {
    const { db, stmt } = stubDb({ meta: { changes: 1 } });

    await expect(claimWebhookEvent(db, 'event-1', NOW)).resolves.toBe(true);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT(webhook_event_id) DO NOTHING'),
    );
    expect(stmt.bind).toHaveBeenCalledWith(
      'event-1',
      NOW.toISOString(),
      new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
    );
  });

  test('returns false when the id was already claimed (ON CONFLICT ignored the insert)', async () => {
    const { db } = stubDb({ meta: { changes: 0 } });

    await expect(claimWebhookEvent(db, 'event-1', NOW)).resolves.toBe(false);
  });

  test('fails open (true) when the backend reports no changes metadata', async () => {
    const { db } = stubDb({});

    await expect(claimWebhookEvent(db, 'event-1', NOW)).resolves.toBe(true);
  });
});

describe('purgeExpiredWebhookEvents', () => {
  test('deletes rows past expires_at and returns the row count', async () => {
    const { db, stmt } = stubDb({ meta: { changes: 7 } });

    await expect(purgeExpiredWebhookEvents(db, NOW)).resolves.toBe(7);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM webhook_event_claims'),
    );
    expect(stmt.bind).toHaveBeenCalledWith(NOW.toISOString());
  });
});
