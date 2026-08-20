import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, content: string) => ({ type, text: content })),
  expandVariables: vi.fn((content: string) => content),
  resolveMetadata: vi.fn().mockResolvedValue({}),
  messageToLogPayload: vi.fn(() => ({ messageType: 'text', content: 'reply' })),
}));

const autoReplyMocks = vi.hoisted(() => ({
  maybeSendOpenAIAutoReply: vi.fn(),
}));

vi.mock('../services/openai-auto-reply.js', () => ({
  maybeSendOpenAIAutoReply: autoReplyMocks.maybeSendOpenAIAutoReply,
}));

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserId,
  getLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);
  autoReplyMocks.maybeSendOpenAIAutoReply.mockResolvedValue({
    matched: false,
    replyTokenConsumed: false,
  });
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      null,
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

// #48: the AI gateway keeps conversation state server-side, so every turn must
// carry ONLY the newest LINE message. A batched delivery (LINE packs several
// message events into one webhook body) is where an accumulating buffer would
// surface as joined prior text.
describe('POST /webhook — AI auto-reply input (#48)', () => {
  test('a batched multi-event body sends each message as its own un-joined input', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    autoReplyMocks.maybeSendOpenAIAutoReply.mockResolvedValue({
      matched: true,
      replyTokenConsumed: true,
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    // The tapped quick-reply label followed by two typed messages — the exact
    // shape that showed up concatenated in the gateway request.
    const texts = ['AI or automation', 'Hi how\u2019s it going', 'Hi how\u2019s it going'];
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: texts.map((text, i) => ({
            type: 'message',
            replyToken: `reply-token-${i}`,
            message: { type: 'text', id: `message-${i}`, text },
            timestamp: Date.now(),
            source: { type: 'user', userId: 'U-existing' },
            webhookEventId: `event-${i}`,
            deliveryContext: { isRedelivery: false },
            mode: 'active',
          })),
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>);

    const inputs = autoReplyMocks.maybeSendOpenAIAutoReply.mock.calls.map(
      (call) => (call[0] as { incomingText: string }).incomingText,
    );
    expect(inputs).toEqual(texts);
    for (const input of inputs) expect(input).not.toContain('\n');
  });
});

// #49: LINE redelivers a webhook when our ACK is slow or fails. Both guards
// below exist so a redelivery can never run the AI turn — and the send — twice.
describe('POST /webhook — redelivery guards (#49)', () => {
  // Stands in for the webhook_event_claims table: the first INSERT for an id
  // reports changes=1, repeats report changes=0 (ON CONFLICT DO NOTHING).
  function claimTrackingDb() {
    const claimed = new Set<string>();
    const db = {
      prepare: (sql: string) => {
        let args: unknown[] = [];
        const stmt = {
          bind: (...bound: unknown[]) => {
            args = bound;
            return stmt;
          },
          run: async () => {
            if (!sql.includes('webhook_event_claims')) return {};
            const id = args[0] as string;
            if (sql.startsWith('DELETE')) {
              claimed.delete(id);
              return { meta: { changes: 1 } };
            }
            const isNew = !claimed.has(id);
            claimed.add(id);
            return { meta: { changes: isNew ? 1 : 0 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        };
        return stmt;
      },
    } as unknown as D1Database;
    return db;
  }

  // Same claim tracking, but the auto_replies SELECT returns one exact-match rule
  // so the keyword reply path actually calls lineClient.replyMessage.
  function claimTrackingDbWithAutoReply() {
    const base = claimTrackingDb();
    const originalPrepare = base.prepare.bind(base);
    return {
      prepare: (sql: string) => {
        const stmt = originalPrepare(sql) as unknown as {
          bind: (...a: unknown[]) => unknown;
          all: () => Promise<{ results: unknown[] }>;
        };
        if (sql.includes('FROM auto_replies')) {
          stmt.all = async () => ({
            results: [
              {
                id: 'rule-1',
                keyword: '\u3053\u3093\u306b\u3061\u306f',
                match_type: 'exact',
                response_type: 'text',
                response_content: '\u3069\u3046\u3082',
                template_id: null,
                is_active: 1,
                created_at: '2026-06-18T12:00:00.000+09:00',
              },
            ],
          });
        }
        return stmt;
      },
    } as unknown as D1Database;
  }

  function messageBody(overrides: Record<string, unknown>) {
    return JSON.stringify({
      destination: 'bot',
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          message: { type: 'text', id: 'message-1', text: 'こんにちは' },
          timestamp: 1750000000000,
          source: { type: 'user', userId: 'U-existing' },
          webhookEventId: 'event-dup',
          deliveryContext: { isRedelivery: false },
          mode: 'active',
          ...overrides,
        },
      ],
    });
  }

  async function post(app: ReturnType<typeof setupApp>, db: D1Database, body: string) {
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body,
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );
    await (vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown> | undefined);
    return res;
  }

  beforeEach(() => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    autoReplyMocks.maybeSendOpenAIAutoReply.mockResolvedValue({
      matched: true,
      replyTokenConsumed: true,
    });
  });

  test('the same webhookEventId delivered twice triggers exactly one AI reply', async () => {
    const db = claimTrackingDb();
    const app = setupApp();

    const first = await post(app, db, messageBody({}));
    const second = await post(app, db, messageBody({}));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(autoReplyMocks.maybeSendOpenAIAutoReply).toHaveBeenCalledTimes(1);
    // The duplicate must not re-run the rest of the handler either.
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  test('a keyword auto-reply is not re-sent for a redelivered event', async () => {
    // The keyword path calls lineClient.replyMessage directly, so this asserts
    // the real send rather than the module-mocked AI helper.
    const db = claimTrackingDbWithAutoReply();
    const app = setupApp();

    await post(app, db, messageBody({ webhookEventId: 'event-keyword-fresh' }));
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);

    await post(
      app,
      db,
      messageBody({ webhookEventId: 'event-keyword-redelivered', deliveryContext: { isRedelivery: true } }),
    );
    expect(lineClientMocks.replyMessage).toHaveBeenCalledTimes(1);
  });

  test('a handler failure releases the claim so the redelivery can retry', async () => {
    const db = claimTrackingDb();
    const app = setupApp();
    autoReplyMocks.maybeSendOpenAIAutoReply.mockRejectedValueOnce(new Error('gateway down'));
    vi.mocked(fireEvent).mockRejectedValueOnce(new Error('bus down'));

    await post(app, db, messageBody({ webhookEventId: 'event-crash' }));
    expect(autoReplyMocks.maybeSendOpenAIAutoReply).toHaveBeenCalledTimes(1);

    // Same id again: the claim was released, so the event is processed afresh.
    await post(app, db, messageBody({ webhookEventId: 'event-crash' }));
    expect(autoReplyMocks.maybeSendOpenAIAutoReply).toHaveBeenCalledTimes(2);
  });

  test('an unclaimed event flagged isRedelivery is recorded but sends no AI reply', async () => {
    const db = claimTrackingDb();
    const app = setupApp();

    const res = await post(
      app,
      db,
      messageBody({ webhookEventId: 'event-redelivered', deliveryContext: { isRedelivery: true } }),
    );

    expect(res.status).toBe(200);
    expect(autoReplyMocks.maybeSendOpenAIAutoReply).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('a fresh event still reaches the AI auto-reply', async () => {
    const db = claimTrackingDb();
    const app = setupApp();

    await post(app, db, messageBody({ webhookEventId: 'event-fresh' }));

    expect(autoReplyMocks.maybeSendOpenAIAutoReply).toHaveBeenCalledTimes(1);
  });
});
