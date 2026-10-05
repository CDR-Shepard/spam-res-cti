/**
 * Test fakes for the AI voice service: an in-memory `AiCallStore` with the
 * same conditional-write semantics as store.ts, a recording Twilio port, a
 * fake ws-like socket, and a registry entry factory. No network, no DB.
 * (Imported only by *.test.ts.)
 */
import type { BridgeSocket } from './bridge.js';
import type { ActiveAiCall } from './registry.js';
import type { AiCallRow, AiCallStore, NewAiCall, TranscriptEntry } from './store.js';
import type { AiVoiceTwilio } from './twilio.js';

export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

export function rowOf(v: NewAiCall & { id: string }): AiCallRow {
  return {
    handoffUserId: null,
    sfObject: null,
    sfRecordId: null,
    fromE164: null,
    isTest: false,
    status: 'queued',
    outcome: null,
    blockReason: null,
    callSid: null,
    answeredBy: null,
    qualification: {},
    transcript: [],
    summary: null,
    callbackAt: null,
    sfTaskId: null,
    ctiCallId: null,
    durationSeconds: null,
    startedAt: null,
    endedAt: null,
    createdAt: new Date('2026-10-05T18:00:00Z'),
    updatedAt: new Date('2026-10-05T18:00:00Z'),
    ...v,
  } as AiCallRow;
}

export interface FakeStore extends AiCallStore {
  rows: Map<string, AiCallRow>;
  optOuts: Array<{ orgId: string; e164: string; note: string }>;
  handoff: Map<string, string>;
  orgNames: Map<string, string>;
  uncounted: number;
}

export function fakeStore(): FakeStore {
  const rows = new Map<string, AiCallRow>();
  const optOuts: FakeStore['optOuts'] = [];
  let seq = 0;
  const put = (id: string, patch: Partial<AiCallRow>) => {
    const cur = rows.get(id);
    if (cur) rows.set(id, { ...cur, ...patch });
  };
  const store: FakeStore = {
    rows,
    optOuts,
    handoff: new Map(),
    orgNames: new Map(),
    uncounted: 0,
    async insert(values) {
      seq += 1;
      const id = values.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const row = rowOf({ ...values, id });
      rows.set(id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async getInOrg(orgId, id) {
      const r = rows.get(id);
      return r && r.orgId === orgId ? r : null;
    },
    async list(orgId, opts) {
      return [...rows.values()]
        .filter((r) => r.orgId === orgId && (!opts.startedBy || r.startedBy === opts.startedBy))
        .slice(0, opts.limit);
    },
    async update(id, patch) {
      put(id, patch as Partial<AiCallRow>);
    },
    async updateWhereStatus(id, from, patch) {
      const r = rows.get(id);
      if (!r || r.endedAt || !(from as readonly string[]).includes(r.status)) return false;
      put(id, patch as Partial<AiCallRow>);
      return true;
    },
    async setOutcome(id, outcome, summary) {
      const r = rows.get(id);
      if (!r) return;
      put(id, { outcome: r.outcome === 'do_not_call' ? r.outcome : outcome, ...(summary !== null ? { summary } : {}) });
    },
    async replaceOutcome(id, from, to) {
      if (rows.get(id)?.outcome === from) put(id, { outcome: to });
    },
    async appendSummary(id, line) {
      const r = rows.get(id);
      if (r) put(id, { summary: r.summary ? `${r.summary}\n${line}` : line });
    },
    async appendTranscript(id, entries: readonly TranscriptEntry[]) {
      const r = rows.get(id);
      if (r) put(id, { transcript: [...(r.transcript as TranscriptEntry[]), ...entries] });
    },
    async mergeQualification(id, fields) {
      const r = rows.get(id);
      if (r) put(id, { qualification: { ...(r.qualification as object), ...fields } });
    },
    async markFailed(id) {
      const r = rows.get(id);
      if (r && !r.endedAt && ['queued', 'ringing', 'in_progress', 'transferring'].includes(r.status)) {
        put(id, { status: 'failed', outcome: r.outcome ?? 'failed' });
      }
    },
    async finalize(id, w) {
      const r = rows.get(id);
      if (!r || r.endedAt) return null;
      const outcome = r.outcome ?? w.derivedOutcome;
      const status = outcome === 'qualified_transferred' ? 'transferred' : outcome === 'failed' ? 'failed' : 'completed';
      put(id, {
        outcome,
        status,
        durationSeconds: w.durationSeconds,
        endedAt: w.endedAt,
        answeredBy: r.answeredBy ?? w.answeredBy,
      });
      return rows.get(id) ?? null;
    },
    async upsertOptOut(orgId, e164, note) {
      if (!optOuts.some((o) => o.orgId === orgId && o.e164 === e164)) optOuts.push({ orgId, e164, note });
    },
    async handoffUserFor(_orgId, sfUserId) {
      return store.handoff.get(sfUserId) ?? null;
    },
    async orgName(orgId) {
      return store.orgNames.get(orgId) ?? null;
    },
    async activeCallTo(orgId, e164) {
      return [...rows.values()].some(
        (r) => r.orgId === orgId && r.toE164 === e164 && !r.endedAt && ['queued', 'ringing', 'in_progress', 'transferring'].includes(r.status),
      );
    },
    async uncountedPlaced() {
      return store.uncounted;
    },
  };
  return store;
}

export interface FakeTwilio extends AiVoiceTwilio {
  placed: Array<Parameters<AiVoiceTwilio['placeCall']>[0]>;
  redirects: Array<{ callSid: string; twiml: string; opts?: { timeLimit?: number } }>;
  hangups: string[];
  failPlace: boolean;
  failRedirect: boolean;
  failHangup: boolean;
}

export const CALL_SID = `CA${'b'.repeat(32)}`;

export function fakeTwilio(): FakeTwilio {
  const t: FakeTwilio = {
    placed: [],
    redirects: [],
    hangups: [],
    failPlace: false,
    failRedirect: false,
    failHangup: false,
    async placeCall(i) {
      if (t.failPlace) throw new Error('twilio says no');
      t.placed.push(i);
      return { callSid: CALL_SID };
    },
    async redirect(callSid, twiml, opts) {
      if (t.failRedirect) throw new Error('redirect failed');
      t.redirects.push({ callSid, twiml, ...(opts ? { opts } : {}) });
    },
    async hangup(callSid) {
      if (t.failHangup) throw new Error('hangup failed');
      t.hangups.push(callSid);
    },
  };
  return t;
}

export interface FakeSocket extends BridgeSocket {
  sent: string[];
  closed: boolean;
  readyState: number;
  emit(ev: 'message' | 'close' | 'error' | 'open', arg?: unknown): void;
}

export function fakeSocket(readyState = 1): FakeSocket {
  const handlers: Record<string, Array<(a?: unknown) => void>> = {};
  const s: FakeSocket = {
    sent: [],
    closed: false,
    readyState,
    send(d: string) {
      s.sent.push(d);
    },
    close() {
      if (s.closed) return;
      s.closed = true;
      s.readyState = 3;
      s.emit('close');
    },
    on(ev: string, cb: (a?: never) => void) {
      (handlers[ev] ??= []).push(cb as (a?: unknown) => void);
    },
    emit(ev: string, arg?: unknown) {
      for (const h of handlers[ev] ?? []) h(arg);
    },
  } as unknown as FakeSocket;
  return s;
}

export function activeEntry(over: Partial<ActiveAiCall> = {}): ActiveAiCall {
  return {
    aiCallId: 'a1',
    orgId: 'o1',
    startedBy: 'u1',
    handoffUserId: 'u1',
    callSid: null,
    toE164: '+16195550100',
    fromE164: '+16195550000',
    isTest: false,
    record: null,
    prompt: {
      agentName: 'Alex',
      companyName: 'GG Homes',
      firstName: 'Jane',
      address: null,
      notes: '',
      isTest: false,
      callbackNumber: '+16195550000',
    },
    bridge: null,
    transcript: null,
    closing: false,
    ...over,
  };
}
