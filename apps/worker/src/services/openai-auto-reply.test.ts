import { beforeEach, describe, expect, test, vi } from 'vitest';

const openAISettingsMocks = vi.hoisted(() => ({
  getEffectiveOpenAISettings: vi.fn(),
}));

vi.mock('../lib/openai-settings.js', () => ({
  getEffectiveOpenAISettings: openAISettingsMocks.getEffectiveOpenAISettings,
}));

import { generateOpenAIReply, maybeSendOpenAIAutoReply } from './openai-auto-reply.js';

const SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
};

function responsesPayload(text: string, id = 'resp_1') {
  return new Response(JSON.stringify({
    id,
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text }],
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Responses payload containing an ask_user_line function_call (and optional narration). */
function askPayload(args: unknown, opts: { narration?: string; id?: string; rawArguments?: string } = {}) {
  const output: unknown[] = [];
  if (opts.narration) {
    output.push({ type: 'message', content: [{ type: 'output_text', text: opts.narration }] });
  }
  output.push({
    type: 'function_call',
    name: 'ask_user_line',
    call_id: 'chatcmpl-tool-1',
    arguments: opts.rawArguments ?? JSON.stringify(args),
  });
  return new Response(JSON.stringify({ id: opts.id ?? 'resp_ask', output }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bubble(text: string) {
  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text }] },
  };
}

/** Responses payload with send_line_flex function_call(s), optional narration and ask. */
function flexPayload(
  calls: Array<{ alt_text?: unknown; contents?: unknown } | string>,
  opts: { narration?: string; ask?: unknown; id?: string } = {},
) {
  const output: unknown[] = [];
  if (opts.narration) {
    output.push({ type: 'message', content: [{ type: 'output_text', text: opts.narration }] });
  }
  for (const [i, call] of calls.entries()) {
    output.push({
      type: 'function_call',
      name: 'send_line_flex',
      call_id: `chatcmpl-flex-${i}`,
      arguments: typeof call === 'string' ? call : JSON.stringify(call),
    });
  }
  if (opts.ask) {
    output.push({
      type: 'function_call',
      name: 'ask_user_line',
      call_id: 'chatcmpl-tool-1',
      arguments: JSON.stringify(opts.ask),
    });
  }
  return new Response(JSON.stringify({ id: opts.id ?? 'resp_flex', output }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function messageChip(label: string) {
  return { type: 'action', action: { type: 'message', label, text: label } };
}

function messageAction(label: string) {
  return { type: 'message', label, text: label };
}

/**
 * Fake D1: `prepare` returns a statement whose `first()` resolves to
 * `sessionRow` for the session SELECT. `runs` records every bound
 * INSERT/UPDATE/DELETE so tests can assert on SQL + params.
 */
function makeDb(sessionRow: { last_response_id: string; turn_count: number } | null = null) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  let session = sessionRow;
  const db = {
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          bound = params;
          return stmt;
        },
        first: vi.fn(async () => (sql.trimStart().startsWith('SELECT') ? session : null)),
        run: vi.fn(async () => {
          runs.push({ sql, params: bound });
          // Multi-turn tests need the next SELECT to see this turn's chaining.
          if (sql.includes('ai_chat_sessions')) {
            session = { last_response_id: bound[2] as string, turn_count: bound[3] as number };
          }
          return {};
        }),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, runs };
}

function baseArgs(db: D1Database, overrides: Partial<Parameters<typeof maybeSendOpenAIAutoReply>[0]> = {}) {
  return {
    db,
    env: {},
    lineClient: {
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    },
    friendId: 'friend-1',
    lineUserId: 'U1',
    incomingText: 'hello',
    replyToken: 'reply-token',
    lineAccountId: 'acc-1',
    createdAt: '2026-07-10T00:00:00.000+09:00',
    ...overrides,
  };
}

/** Gateway 404 for a previous_response_id whose session was reaped server-side. */
function responseNotFound(id = 'resp_dead') {
  return new Response(
    JSON.stringify({ error: { message: `Response not found: ${id}`, type: 'invalid_request_error' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('generateOpenAIReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns null when required OpenAI settings are missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      generateOpenAIReply({ baseUrl: null, apiKey: null, model: null }, 'hello', null),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('calls the responses endpoint with store: true and returns text + response id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('Hello from OpenAI', 'resp_abc'),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toEqual({
      text: 'Hello from OpenAI',
      ask: null,
      flex: [],
      responseId: 'resp_abc',
      sessionReset: false,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ' + 'sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      input: 'hello',
      store: true,
    });
  });

  test('sends previous_response_id when continuing a session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('continued'),
    );

    await generateOpenAIReply(SETTINGS, 'hello again', 'resp_prev');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBe('resp_prev');
  });

  test('falls back to the output_text convenience field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1', output_text: 'Hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toEqual({
      text: 'Hello world',
      ask: null,
      flex: [],
      responseId: 'resp_1',
      sessionReset: false,
    });
  });

  test('returns null when upstream returns malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toBeNull();
  });

  // Real hermes-agent gateway shape: every plugin tool is dispatched through a
  // generic `tool_call` wrapper whose `arguments` is a JSON string of
  // { name, arguments:<OBJECT> } — NOT a flat function_call named ask_user_line.
  function toolCallWrappedPayload(
    inner: { name: string; arguments: unknown },
    opts: { narration?: string; id?: string } = {},
  ) {
    const output: unknown[] = [];
    if (opts.narration) {
      output.push({ type: 'message', content: [{ type: 'output_text', text: opts.narration }] });
    }
    output.push({
      type: 'function_call',
      name: 'tool_call',
      call_id: 'chatcmpl-tool-1',
      arguments: JSON.stringify(inner),
    });
    return new Response(JSON.stringify({ id: opts.id ?? 'resp_wrapped', output }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  test('unwraps a tool_call-wrapped ask_user_line (real hermes-agent shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toolCallWrappedPayload(
        { name: 'ask_user_line', arguments: { message: 'Do you want a discount?', kind: 'confirm' } },
        { narration: 'Please tap Yes or No above.', id: 'resp_w' },
      ),
    );

    await expect(generateOpenAIReply(SETTINGS, 'discount?', null)).resolves.toEqual({
      text: 'Please tap Yes or No above.',
      ask: { message: 'Do you want a discount?', kind: 'confirm' },
      flex: [],
      responseId: 'resp_w',
      sessionReset: false,
    });
  });

  test('unwraps a tool_call-wrapped send_line_flex', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      toolCallWrappedPayload({
        name: 'send_line_flex',
        arguments: { alt_text: 'Card', contents: bubble('hi') },
      }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'show card', null);
    expect(result?.flex).toHaveLength(1);
    expect(result?.flex[0]).toMatchObject({ type: 'flex', altText: 'Card' });
  });

  test('extracts an ask_user_line function_call alongside narration text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(
        { message: 'Which branch?', kind: 'choice', options: ['main', 'develop'] },
        { narration: 'One quick question.', id: 'resp_q' },
      ),
    );

    await expect(generateOpenAIReply(SETTINGS, 'deploy it', null)).resolves.toEqual({
      text: 'One quick question.',
      ask: { message: 'Which branch?', kind: 'choice', options: ['main', 'develop'] },
      flex: [],
      responseId: 'resp_q',
      sessionReset: false,
    });
  });

  test('clamps choice options server-side: truncates labels to 20 chars, drops empties/dupes, caps at 13', async () => {
    const options = [
      'a-really-long-label-way-over-twenty-chars', // truncated to 20
      '  ', // empty after trim → dropped
      'dup',
      'dup', // duplicate → dropped
      ...Array.from({ length: 15 }, (_, i) => `opt-${i}`), // overflow → capped
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick one', kind: 'choice', options }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask?.options).toHaveLength(13);
    expect(result?.ask?.options?.[0]).toBe('a-really-long-label-');
    expect(result?.ask?.options?.[0]).toHaveLength(20);
    expect(result?.ask?.options?.filter((o) => o === 'dup')).toHaveLength(1);
  });

  test('label truncation never splits a surrogate pair (emoji at the 20-char cut)', async () => {
    // 19 ascii chars + an emoji (2 UTF-16 units) straddling the cut point.
    const straddling = 'x'.repeat(19) + '🚀 extra';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick', kind: 'choice', options: [straddling, 'other'] }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask?.options?.[0]).toBe('x'.repeat(19)); // lone surrogate dropped
  });

  test('choice with fewer than 2 usable options degrades to freetext', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick one', kind: 'choice', options: ['only', '  '] }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask).toEqual({ message: 'Pick one', kind: 'freetext' });
  });

  test('malformed ask arguments fall back to narration text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { narration: 'Working on it.', rawArguments: '{not json' }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toEqual({
      text: 'Working on it.',
      ask: null,
      flex: [],
      responseId: 'resp_ask',
      sessionReset: false,
    });
  });

  test('malformed ask arguments with no narration returns null (nothing AI-generated to send)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { rawArguments: '{not json' }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
  });

  test('a rejected first ask attempt does not shadow the corrected retry in the same turn', async () => {
    // Plugin validation errors let the model retry within one turn, so the
    // output array can hold several ask_user_line calls. The last valid one wins.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_retry',
        output: [
          { type: 'function_call', name: 'ask_user_line', arguments: JSON.stringify({ kind: 'choice', options: ['only'] }) }, // missing message → invalid
          { type: 'function_call', name: 'ask_user_line', arguments: JSON.stringify({ message: 'Pick', kind: 'choice', options: ['A', 'B'] }) },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask).toEqual({ message: 'Pick', kind: 'choice', options: ['A', 'B'] });
  });

  test('ask with unknown kind or missing message is rejected', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(askPayload({ message: 'When?', kind: 'datetime' }))
      .mockResolvedValueOnce(askPayload({ kind: 'freetext' }));

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
  });

  // #50: the gateway can reap the session behind previous_response_id. Without
  // a retry the friend is stuck: every later turn resends the dead id and gets
  // no reply.
  test('retries once without previous_response_id when the gateway rejects it as not found', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseNotFound('resp_dead'))
      .mockResolvedValueOnce(responsesPayload('fresh start', 'resp_fresh'));

    await expect(generateOpenAIReply(SETTINGS, 'hello', 'resp_dead')).resolves.toEqual({
      text: 'fresh start',
      ask: null,
      flex: [],
      responseId: 'resp_fresh',
      sessionReset: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).previous_response_id).toBe('resp_dead');
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string)).not.toHaveProperty('previous_response_id');
  });

  test('does not retry a 404 that is not about the previous response id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'The model `gpt-x` does not exist', type: 'invalid_request_error' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', 'resp_prev')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('does not retry auth or 5xx failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Response not found: whatever' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', 'resp_prev')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('does not retry when there was no previous_response_id to blame', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseNotFound());

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('returns null when the fresh retry also fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseNotFound())
      .mockResolvedValueOnce(new Response('gateway down', { status: 502 }));

    await expect(generateOpenAIReply(SETTINGS, 'hello', 'resp_dead')).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('maybeSendOpenAIAutoReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns unmatched when OpenAI settings are missing', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: null,
      apiKey: null,
      model: null,
    });
    const { db } = makeDb();
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: false,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.replyMessage).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('first message starts a session: no previous_response_id, turn_count 1', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('AI reply', 'resp_new'),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBeUndefined();
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: 'AI reply' }]);

    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params).toEqual(['friend-1', 'acc-1', 'resp_new', 1, '2026-07-10T00:00:00.000+09:00']);
    expect(runs.some((r) => r.sql.includes('messages_log'))).toBe(true);
  });

  test('existing session chains previous_response_id and increments turn_count', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('AI reply', 'resp_6'),
    );
    const { db, runs } = makeDb({ last_response_id: 'resp_5', turn_count: 5 });
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBe('resp_5');
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_6');
    expect(sessionUpsert?.params[3]).toBe(6);
  });

  // #50 regression: stale previous_response_id → one reply is still delivered
  // and the session row restarts at turn 1 with the new id.
  test('a rejected previous_response_id still delivers a reply and resets the session row', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responseNotFound('resp_dead'))
      .mockResolvedValueOnce(responsesPayload('AI reply', 'resp_new'));
    const { db, runs } = makeDb({ last_response_id: 'resp_dead', turn_count: 4 });
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(args.lineClient.replyMessage).toHaveBeenCalledTimes(1);
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: 'AI reply' }]);

    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_new');
    expect(sessionUpsert?.params[3]).toBe(1);
  });

  test('session at max turns starts fresh: previous_response_id omitted, turn_count resets to 1', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('fresh start', 'resp_fresh'),
    );
    const { db, runs } = makeDb({ last_response_id: 'resp_30', turn_count: 30 });
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBeUndefined();
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_fresh');
    expect(sessionUpsert?.params[3]).toBe(1);
  });

  test('notePrefix is prepended to the same reply call and logged as system_note', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responsesPayload('AI reply'));
    const { db, runs } = makeDb(null);
    const args = baseArgs(db, { notePrefix: '新しい会話を開始しました。以前の会話内容は引き継がれません。' });

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: '新しい会話を開始しました。以前の会話内容は引き継がれません。' },
      { type: 'text', text: 'AI reply' },
    ]);
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(2);
    expect(logs[0].sql).toContain("'system_note'");
    expect(logs[0].params).toContain('新しい会話を開始しました。以前の会話内容は引き継がれません。');
    expect(logs[1].sql).toContain("'auto_reply'");
  });

  test('falls back to pushMessage when reply token is invalid', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responsesPayload('AI reply'));
    const { db, runs } = makeDb(null);
    const args = baseArgs(db, {
      lineClient: {
        replyMessage: vi.fn().mockRejectedValue(new Error('Invalid reply token')),
        pushMessage: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.pushMessage).toHaveBeenCalledWith('U1', [{ type: 'text', text: 'AI reply' }]);
    expect(runs.some((r) => r.sql.includes('messages_log'))).toBe(true);
  });

  test('choice with 5+ options renders as a text message with quick-reply chips', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const options = ['main', 'develop', 'staging', 'hotfix', 'release'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Which branch?', kind: 'choice', options }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      {
        type: 'text',
        text: 'Which branch?',
        quickReply: { items: options.map(messageChip) },
      },
    ]);
    // The ask turn still advances the session chain.
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_ask');
    // The ask is logged as a plain text message (chips are ephemeral UI).
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(1);
    expect(logs[0].params).toContain('Which branch?');
  });

  test('choice with 13 options renders 13 quick-reply chips (upper bound)', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const options = Array.from({ length: 13 }, (_, i) => `opt-${i}`);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick one', kind: 'choice', options }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(messages[0].quickReply.items).toEqual(options.map(messageChip));
  });

  test('confirm ask renders as a confirm template with two persistent buttons', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Proceed?', kind: 'confirm' }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toEqual([
      {
        type: 'template',
        altText: 'Proceed?',
        template: {
          type: 'confirm',
          text: 'Proceed?',
          actions: [messageAction('Yes'), messageAction('No')],
        },
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain('quickReply');
    // Logged as plain text with the question as durable content.
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(1);
    expect(logs[0].params).toContain('text');
    expect(logs[0].params).toContain('Proceed?');
  });

  test('choice with 3 options renders as a buttons template with 3 actions', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Which branch?', kind: 'choice', options: ['main', 'develop', 'staging'] }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      {
        type: 'template',
        altText: 'Which branch?',
        template: {
          type: 'buttons',
          text: 'Which branch?',
          actions: [messageAction('main'), messageAction('develop'), messageAction('staging')],
        },
      },
    ]);
  });

  test('choice with exactly 4 options still renders as a buttons template (boundary)', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick', kind: 'choice', options: ['A', 'B', 'C', 'D'] }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages[0].type).toBe('template');
    expect(messages[0].template.type).toBe('buttons');
    expect(messages[0].template.actions).toHaveLength(4);
  });

  test('long confirm question (>240 chars) is delivered in full as text plus a truncated template', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const longQuestion = 'Q'.repeat(300);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: longQuestion, kind: 'confirm' }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toHaveLength(2);
    // Full question first as plain text; the template carries a 240-char stub.
    expect(messages[0]).toEqual({ type: 'text', text: longQuestion });
    expect(messages[1].type).toBe('template');
    expect(messages[1].template.text).toBe('Q'.repeat(240));
    expect(messages[1].altText).toBe(longQuestion); // under the 400 altText cap
    // Both messages logged; the full question is durable in the log.
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(2);
    expect(logs[0].params).toContain(longQuestion);
  });

  test('narration + confirm sends [text, template] in that order', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(
        { message: 'Proceed?', kind: 'confirm' },
        { narration: 'I found 3 stale branches.' },
      ),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'I found 3 stale branches.' },
      {
        type: 'template',
        altText: 'Proceed?',
        template: {
          type: 'confirm',
          text: 'Proceed?',
          actions: [messageAction('Yes'), messageAction('No')],
        },
      },
    ]);
    // Both AI messages are logged.
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(2);
    expect(logs[0].params).toContain('I found 3 stale branches.');
    expect(logs[1].params).toContain('Proceed?');
  });

  test('freetext ask sends a plain question without quickReply', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'What name should I use?', kind: 'freetext' }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'What name should I use?' },
    ]);
  });

  test('notePrefix stays first and the question template stays last', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Which one?', kind: 'choice', options: ['A', 'B'] }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db, { notePrefix: '新しい会話を開始しました。' });

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: '新しい会話を開始しました。' });
    expect(messages[1].type).toBe('template');
    expect(messages[1].template.actions).toEqual([messageAction('A'), messageAction('B')]);
  });

  test('malformed ask arguments without narration sends nothing and does not crash the webhook path', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { rawArguments: '{not json' }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: false,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.replyMessage).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  test('resume leg: tapped chip label flows as plain input with previous_response_id', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('Deploying develop now.', 'resp_after'),
    );
    // Session persisted by the ask turn; the user then taps the "develop" chip,
    // which arrives as a NORMAL text webhook event.
    const { db } = makeDb({ last_response_id: 'resp_ask', turn_count: 2 });
    const args = baseArgs(db, { incomingText: 'develop' });

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.input).toBe('develop');
    expect(body.previous_response_id).toBe('resp_ask');
  });

  test('flex bubble is delivered as a flex message and logged with the raw container JSON', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const contents = bubble('Order #123');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      flexPayload([{ alt_text: 'Order summary', contents }]),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'flex', altText: 'Order summary', contents },
    ]);
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(1);
    expect(logs[0].params).toContain('flex');
    expect(logs[0].params).toContain(JSON.stringify(contents));
  });

  test('narration + flex carousel + ask send in order: text, flex, question last', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const carousel = { type: 'carousel', contents: [bubble('Plan A'), bubble('Plan B')] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      flexPayload([{ alt_text: 'Plans', contents: carousel }], {
        narration: 'Here are your options.',
        ask: { message: 'Which plan?', kind: 'choice', options: ['A', 'B'] },
      }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages.map((m: { type: string }) => m.type)).toEqual(['text', 'flex', 'template']);
    expect(messages[1].contents).toEqual(carousel);
  });

  test('carousel over 12 bubbles is clamped to 12; invalid flex calls are skipped', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const bubbles = Array.from({ length: 15 }, (_, i) => bubble(`Item ${i}`));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      flexPayload([
        '{not json',
        { alt_text: 'Bad', contents: { type: 'video' } },
        { alt_text: 'Catalog', contents: { type: 'carousel', contents: bubbles } },
      ]),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('flex');
    expect(messages[0].contents.contents).toHaveLength(12);
  });

  test('missing alt_text falls back to the first text found inside the flex contents', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      flexPayload([{ contents: bubble('Fallback title') }]),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages[0].altText).toBe('Fallback title');
  });

  test('excess flex is dropped to fit the per-send cap; the ask stays last', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const calls = Array.from({ length: 5 }, (_, i) => ({
      alt_text: `Card ${i}`,
      contents: bubble(`Card ${i}`),
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      flexPayload(calls, {
        narration: 'Here you go.',
        ask: { message: 'More?', kind: 'confirm' },
      }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    // Cap is 4 AI messages: text + 2 flex + confirm template (3 flex dropped).
    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages.map((m: { type: string }) => m.type)).toEqual([
      'text',
      'flex',
      'flex',
      'template',
    ]);
    expect(messages[3].template.type).toBe('confirm');
  });
});

// #48: the gateway keeps conversation state server-side, so each turn must post
// ONLY the newest LINE message as `input` and chain via previous_response_id.
// A batched webhook (several message events in one delivery) is the case where
// an accumulating buffer would show up as `\n\n`-joined prior text.
describe('input carries only the newest message (#48)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a batched multi-event webhook posts one un-joined input per message', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(responsesPayload('ack 1', 'resp_1'))
      .mockResolvedValueOnce(responsesPayload('ack 2', 'resp_2'))
      .mockResolvedValueOnce(responsesPayload('ack 3', 'resp_3'));
    const { db } = makeDb(null);

    // The webhook handler walks body.events sequentially; each text event is
    // its own auto-reply turn.
    const texts = ['AI or automation', "Hi how's it going", "Hi how's it going"];
    for (const incomingText of texts) {
      await maybeSendOpenAIAutoReply(baseArgs(db, { incomingText }));
    }

    const inputs = fetchSpy.mock.calls.map(
      (call) => JSON.parse(call[1]!.body as string).input as string,
    );
    expect(inputs).toEqual(texts);
    for (const input of inputs) expect(input).not.toContain('\n');

    // State lives upstream: turns 2 and 3 chain instead of resending history.
    const prevIds = fetchSpy.mock.calls.map(
      (call) => JSON.parse(call[1]!.body as string).previous_response_id,
    );
    expect(prevIds).toEqual([undefined, 'resp_1', 'resp_2']);
  });

  test('the request body carries no field other than model/input/store/previous_response_id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(responsesPayload('ok', 'resp_x'));

    await generateOpenAIReply(SETTINGS, 'tapped label', 'resp_prev');

    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toEqual({
      model: 'gpt-4o-mini',
      input: 'tapped label',
      store: true,
      previous_response_id: 'resp_prev',
    });
  });
});
