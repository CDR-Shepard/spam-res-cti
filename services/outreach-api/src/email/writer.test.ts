import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { costMicros } from '../ai/model.js';
import { spentTodayMicros } from '../ai/budget.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { buildWriterPrompt, type WriterInput } from './writer-prompt.js';
import {
  AnthropicEmailWriter,
  EMAIL_TOOL,
  EMAIL_TOOL_NAME,
  EmailDecision,
  EmailOutputError,
  samEmailConfigured,
  writeEmail,
  type EmailWriter,
} from './writer.js';

const NOW = new Date('2026-10-20T16:00:00.000Z');
const ORG = '11111111-1111-4111-8111-111111111111';
const SECRET = 'my attorney will hear about the 450k Maple Street house';

const input: WriterInput = {
  mode: 'reply',
  firstName: 'Pat',
  companyName: 'GG Homes',
  planText: null,
  history: '',
  inbound: { subject: 'Re: Your home', text: SECRET },
  localTime: 'Tuesday, October 20, 2026, 9:05 AM',
};
const first: WriterInput = { ...input, mode: 'first', inbound: null };

const sendDecision: EmailDecision = { action: 'send', flagReason: null, subject: 'Your home on Maple Street', body: "Hi Pat, I'm Sam, GG Homes' AI assistant. Is the house still for sale?" };

type Block = { type: string; name?: string; input?: unknown; text?: string };
const client = (content: Block[], usage = { input_tokens: 2_000, output_tokens: 300 }) => ({ messages: { create: vi.fn(async () => ({ content, usage })) } });

/**
 * A db with just the two statements `ai/budget.ts` runs (spentTodayMicros' select and addSpend's upsert), so the unit
 * tests need no Postgres. The pg block at the bottom runs the same flow against the real table.
 */
function fakeDb(spent = 0, opts: { failSelect?: boolean; failInsert?: boolean } = {}) {
  const added: number[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          if (opts.failSelect) throw new Error('select down');
          return [{ costMicros: spent }];
        },
      }),
    }),
    insert: () => ({
      values: (v: { costMicros: number }) => ({
        onConflictDoUpdate: async () => {
          if (opts.failInsert) throw new Error('insert down');
          added.push(v.costMicros);
        },
      }),
    }),
  };
  return { db: db as unknown as Db, added };
}

const written = (over: Partial<Awaited<ReturnType<EmailWriter['write']>>> = {}) => ({
  decision: sendDecision,
  model: 'claude-sonnet-5-5',
  inputTokens: 2_000,
  outputTokens: 300,
  ...over,
});
const fakeWriter = (result = written(), modelId?: string): EmailWriter & { write: ReturnType<typeof vi.fn> } => ({
  ...(modelId === undefined ? {} : { modelId }),
  write: vi.fn(async () => result),
});

describe('samEmailConfigured', () => {
  const writer = { write: vi.fn() } as unknown as EmailWriter;
  it('is true only when Resend is set up AND Sam has a writer', () => {
    expect(samEmailConfigured({ emailEnabled: true }, writer)).toBe(true);
    expect(samEmailConfigured({ emailEnabled: true }, null)).toBe(false);
    expect(samEmailConfigured({ emailEnabled: false }, writer)).toBe(false);
    expect(samEmailConfigured({ emailEnabled: false }, null)).toBe(false);
  });
});

describe('EmailDecision', () => {
  it('accepts every action and flag reason of the contract', () => {
    for (const action of ['send', 'flag', 'opt_out', 'not_interested', 'no_reply'] as const) {
      const flagReason = action === 'flag' ? 'unsure' : null;
      expect(EmailDecision.safeParse({ action, flagReason, subject: 's', body: 'b' }).success, action).toBe(true);
    }
    for (const flagReason of ['offer_or_price', 'angry_or_threat', 'legal', 'not_owner', 'wants_appointment', 'unsure'] as const) {
      expect(EmailDecision.safeParse({ action: 'flag', flagReason, subject: 's', body: 'b' }).success, flagReason).toBe(true);
    }
  });

  it('refuses an unknown action or flag reason, and a missing field', () => {
    expect(EmailDecision.safeParse({ ...sendDecision, action: 'forward' }).success).toBe(false);
    expect(EmailDecision.safeParse({ action: 'flag', flagReason: 'other_sender', subject: 's', body: 'b' }).success).toBe(false);
    const { body: _body, ...noBody } = sendDecision;
    expect(EmailDecision.safeParse(noBody).success).toBe(false);
  });

  it('a send has a body; the actions that send nothing (or only a thank-you) need no subject or body', () => {
    expect(EmailDecision.safeParse({ ...sendDecision, body: '  \n' }).success).toBe(false);
    expect(EmailDecision.safeParse({ action: 'opt_out', flagReason: null, subject: '', body: '' }).success).toBe(true);
    expect(EmailDecision.safeParse({ action: 'no_reply', flagReason: null, subject: '', body: '' }).success).toBe(true);
  });

  it('a send with a blank subject is a valid answer: a reply keeps the seller\'s subject (writeEmail refuses it for a first email)', () => {
    expect(EmailDecision.safeParse({ ...sendDecision, subject: '' }).success).toBe(true);
    expect(EmailDecision.safeParse({ ...sendDecision, subject: ' ' }).success).toBe(true);
  });

  it('a flag with no reason reads as unsure, rather than throwing the answer away', () => {
    expect(EmailDecision.parse({ action: 'flag', flagReason: null, subject: '', body: 'Thanks, someone will follow up.' })).toEqual({
      action: 'flag',
      flagReason: 'unsure',
      subject: '',
      body: 'Thanks, someone will follow up.',
    });
    // A reason it did give is kept, and the other actions keep their null.
    expect(EmailDecision.parse({ action: 'flag', flagReason: 'legal', subject: '', body: 'b' }).flagReason).toBe('legal');
    expect(EmailDecision.parse({ action: 'no_reply', flagReason: null, subject: '', body: '' }).flagReason).toBeNull();
  });
});

describe('AnthropicEmailWriter', () => {
  it('asks a Claude 5 model for structured output (a forced tool choice is refused) and returns the validated decision with usage', async () => {
    const c = client([{ type: 'text', text: JSON.stringify(sendDecision) }]);
    const out = await new AnthropicEmailWriter({ client: c, model: 'claude-sonnet-5-5' }).write({ system: 'S', user: 'U' });
    expect(out).toEqual({ decision: sendDecision, model: 'claude-sonnet-5-5', inputTokens: 2_000, outputTokens: 300 });
    expect(c.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5-5',
        system: 'S',
        messages: [{ role: 'user', content: 'U' }],
        output_config: { format: { type: 'json_schema', schema: expect.objectContaining({ type: 'object', required: ['action', 'flagReason', 'subject', 'body'] }) } },
      }),
      expect.anything(),
    );
    const request = (c.messages.create.mock.calls[0] as unknown as [{ max_tokens: number }])[0];
    // Claude 5 thinks before it answers: room for that and a 150-word email.
    expect(request.max_tokens).toBeGreaterThanOrEqual(2_000);
  });

  it('forces the email_decision tool on a Claude 4 model', async () => {
    const c = client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: sendDecision }]);
    await new AnthropicEmailWriter({ client: c, model: 'claude-haiku-4-5-20251001' }).write({ system: 'S', user: 'U' });
    expect(EMAIL_TOOL_NAME).toBe('email_decision');
    expect(c.messages.create).toHaveBeenCalledWith(expect.objectContaining({ tools: [EMAIL_TOOL], tool_choice: { type: 'tool', name: 'email_decision' } }), expect.anything());
  });

  it('exposes the model id it prices with', () => {
    expect(new AnthropicEmailWriter({ client: client([]), model: 'claude-opus-5' }).modelId).toBe('claude-opus-5');
  });

  it('throws EmailOutputError carrying usage when the model answers with nothing usable, never repeating what it wrote', async () => {
    const usage = { inputTokens: 2_000, outputTokens: 300, model: 'claude-sonnet-5-5' };
    const bad: Block[][] = [
      [{ type: 'text', text: 'this is not json' }],
      [{ type: 'text' }],
      [],
      [{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: { ...sendDecision, action: SECRET } }],
      [{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: { action: 'send', flagReason: null, subject: SECRET, body: ' ' } }],
    ];
    for (const content of bad) {
      const err = await new AnthropicEmailWriter({ client: client(content), model: 'claude-sonnet-5-5' }).write({ system: 'S', user: 'U' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailOutputError);
      expect((err as EmailOutputError).usage).toEqual(usage);
      expect((err as Error).message).not.toContain(SECRET);
    }
  });

  it('passes the abort signal to the SDK call', async () => {
    const c = client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: sendDecision }]);
    const controller = new AbortController();
    await new AnthropicEmailWriter({ client: c, model: 'claude-sonnet-5-5' }).write({ system: 'S', user: 'U' }, { signal: controller.signal });
    expect(c.messages.create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });
});

describe('writeEmail (fake db)', () => {
  it('writes from the built prompt, returns the decision and charges what the call cost', async () => {
    const { db, added } = fakeDb(0);
    const writer = fakeWriter();
    const out = await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input);
    expect(out).toEqual({ kind: 'ok', decision: sendDecision });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write.mock.calls[0]![0]).toEqual(buildWriterPrompt(input));
    expect(added).toEqual([costMicros('claude-sonnet-5-5', 2_000, 300)]);
  });

  it('a valid tool input through the real adapter is ok', async () => {
    const { db, added } = fakeDb();
    const writer = new AnthropicEmailWriter({ client: client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: sendDecision }]), model: 'claude-haiku-4-5-20251001' });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toEqual({ kind: 'ok', decision: sendDecision });
    expect(added).toEqual([2_000 * 1 + 300 * 5]);
  });

  it('invalid JSON from the model is failed (invalid_output), and the call it cost is still charged', async () => {
    const { db, added } = fakeDb();
    const writer = new AnthropicEmailWriter({ client: client([{ type: 'text', text: `{"action": "send", ${SECRET}` }]), model: 'claude-sonnet-5-5' });
    const out = await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input);
    expect(out).toEqual({ kind: 'failed', reason: 'invalid_output' });
    expect(JSON.stringify(out)).not.toContain('Maple');
    expect(added).toEqual([costMicros('claude-sonnet-5-5', 2_000, 300)]);
  });

  it('a day already at its budget is over_budget, and the model is never called', async () => {
    const { db, added } = fakeDb(25_000_000);
    const writer = fakeWriter();
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toEqual({ kind: 'over_budget' });
    expect(writer.write).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it("uses the tenant's own daily budget from its settings", async () => {
    const writer = fakeWriter();
    const { db } = fakeDb(600_000);
    expect(await writeEmail({ db, writer, orgId: ORG, settings: { aiDailyBudgetUsd: 0.5 }, now: NOW }, input)).toEqual({ kind: 'over_budget' });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: { aiDailyBudgetUsd: 1 }, now: NOW }, input)).toMatchObject({ kind: 'ok' });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: 'not an object', now: NOW }, input)).toMatchObject({ kind: 'ok' });
  });

  it('a model the cost table cannot price is refused before any call', async () => {
    const { db, added } = fakeDb();
    const c = client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: sendDecision }]);
    const out = await writeEmail({ db, writer: new AnthropicEmailWriter({ client: c, model: 'claude-mystery-9' }), orgId: ORG, settings: {}, now: NOW }, input);
    expect(out).toEqual({ kind: 'failed', reason: 'unpriced_model' });
    expect(c.messages.create).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it('a writer that does not say its model is checked after the call: an answer that cannot be priced is not used', async () => {
    const { db, added } = fakeDb();
    const out = await writeEmail({ db, writer: fakeWriter(written({ model: 'claude-mystery-9' })), orgId: ORG, settings: {}, now: NOW }, input);
    expect(out).toEqual({ kind: 'failed', reason: 'unpriced_model' });
    expect(added).toEqual([]);
  });

  it('a model error is failed (model_error), costs nothing, and never carries what the error said', async () => {
    const { db, added } = fakeDb();
    const writer: EmailWriter = { write: vi.fn(async () => Promise.reject(new Error(`boom: ${SECRET}`))) };
    const out = await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input);
    expect(out).toEqual({ kind: 'failed', reason: 'model_error' });
    expect(added).toEqual([]);
  });

  it('an aborted call is failed (aborted)', async () => {
    const { db } = fakeDb();
    const controller = new AbortController();
    const writer: EmailWriter = { write: vi.fn(async () => { controller.abort(); throw new Error('aborted'); }) };
    const out = await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW, signal: controller.signal }, input);
    expect(out).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(writer.write).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  it('a first email whose action is not send is failed (declined: Sam chose not to write, the seller page says so), and still charged', async () => {
    const { db, added } = fakeDb();
    const writer = fakeWriter(written({ decision: { action: 'no_reply', flagReason: null, subject: '', body: '' } }));
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, first)).toEqual({ kind: 'failed', reason: 'declined' });
    expect(added).toHaveLength(1);
    // The same decision is fine for a reply.
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toMatchObject({ kind: 'ok' });
  });

  it('a send with a blank subject is ok for a reply (the caller sets "Re: ...") and invalid_output for a first email, charged either way', async () => {
    const { db, added } = fakeDb();
    const blank = { ...sendDecision, subject: '  ' };
    const writer = new AnthropicEmailWriter({ client: client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: blank }]), model: 'claude-haiku-4-5-20251001' });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toEqual({ kind: 'ok', decision: blank });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, first)).toEqual({ kind: 'failed', reason: 'invalid_output' });
    expect(added).toHaveLength(2);
  });

  it('a flag with no reason through the real adapter is ok, as unsure', async () => {
    const { db } = fakeDb();
    const writer = new AnthropicEmailWriter({
      client: client([{ type: 'tool_use', name: EMAIL_TOOL_NAME, input: { action: 'flag', flagReason: null, subject: '', body: 'Thanks!' } }]),
      model: 'claude-haiku-4-5-20251001',
    });
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toEqual({ kind: 'ok', decision: { action: 'flag', flagReason: 'unsure', subject: '', body: 'Thanks!' } });
  });

  it('a budget that cannot be read is failed (budget_unavailable), and the model is not called', async () => {
    const { db } = fakeDb(0, { failSelect: true });
    const writer = fakeWriter();
    expect(await writeEmail({ db, writer, orgId: ORG, settings: {}, now: NOW }, input)).toEqual({ kind: 'failed', reason: 'budget_unavailable' });
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('spend that cannot be recorded does not throw away the email it paid for, and is logged without any text', async () => {
    const { db } = fakeDb(0, { failInsert: true });
    const log = { warn: vi.fn() };
    const out = await writeEmail({ db, writer: fakeWriter(), orgId: ORG, settings: {}, now: NOW, log }, input);
    expect(out).toEqual({ kind: 'ok', decision: sendDecision });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/Maple|attorney|Pat/);
  });

  it('never throws, whatever goes wrong', async () => {
    const { db } = fakeDb();
    const broken = await writeEmail({ db, writer: fakeWriter(), orgId: ORG, settings: {}, now: NOW }, null as unknown as WriterInput);
    expect(broken).toEqual({ kind: 'failed', reason: 'unexpected_error' });
  });
});

describe.skipIf(!pgLane)('writeEmail (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  }, 120_000);

  it('adds the call to the tenant\'s day, and the next call is over_budget once the day is spent', async () => {
    const orgId = await seedOrg(db);
    const settings = { aiDailyBudgetUsd: 0.01 };
    // 2,000 in + 300 out on Sonnet 5.5 = 7,000 micro-dollars, so the second call starts at 7,000 of 10,000.
    const writer = fakeWriter();
    expect(await writeEmail({ db, writer, orgId, settings, now: NOW }, input)).toMatchObject({ kind: 'ok' });
    expect(await spentTodayMicros(db, orgId, NOW)).toBe(7_000);
    expect(await writeEmail({ db, writer, orgId, settings, now: NOW }, input)).toMatchObject({ kind: 'ok' });
    expect(await spentTodayMicros(db, orgId, NOW)).toBe(14_000);
    expect(await writeEmail({ db, writer, orgId, settings, now: NOW }, input)).toEqual({ kind: 'over_budget' });
    expect(writer.write).toHaveBeenCalledTimes(2);
    // Another tenant's day is its own.
    expect(await spentTodayMicros(db, await seedOrg(db), NOW)).toBe(0);
  });
});
