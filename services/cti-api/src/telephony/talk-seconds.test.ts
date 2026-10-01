import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { applyTalkSeconds, parseTwilioSeconds, talkSecondsWrite } from './talk-seconds.js';

const PARENT = `CA${'a'.repeat(32)}`;
const CHILD = `CA${'b'.repeat(32)}`;

describe('talkSecondsWrite — only durations that measure the connected line', () => {
  it('<Dial action>, connected: DialCallDuration, written unconditionally', () => {
    expect(talkSecondsWrite({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' }))
      .toEqual({ mode: 'set', seconds: 37 });
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'answered', DialCallDuration: '12' }))
      .toEqual({ mode: 'set', seconds: 12 });
  });

  it('<Dial action>, never connected: 0 — ringing is not talk time', () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: status, DialCallDuration: '0' }))
        .toEqual({ mode: 'set', seconds: 0 });
    }
  });

  it('<Dial action>, connected but no usable duration: writes nothing', () => {
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'completed' })).toBeNull();
    expect(talkSecondsWrite({ CallSid: PARENT, DialCallStatus: 'completed', DialCallDuration: 'abc' })).toBeNull();
  });

  it("the dialed leg's own completed callback: its CallDuration, only while nothing is there yet", () => {
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed', CallDuration: '41' }))
      .toEqual({ mode: 'if_unset', seconds: 41 });
  });

  it('a dialed leg that ended unanswered: 0, only while nothing is there yet', () => {
    for (const status of ['no-answer', 'busy', 'failed', 'canceled']) {
      expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: status }))
        .toEqual({ mode: 'if_unset', seconds: 0 });
    }
  });

  it("a dialed leg's non-final callback says nothing", () => {
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'ringing' })).toBeNull();
    expect(talkSecondsWrite({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed' })).toBeNull();
  });

  it("the rep's own (parent) leg callback NEVER writes — its CallDuration includes the ringing", () => {
    expect(talkSecondsWrite({ CallSid: PARENT, CallStatus: 'completed', CallDuration: '58' })).toBeNull();
  });
});

describe('parseTwilioSeconds', () => {
  it('accepts whole non-negative seconds only', () => {
    expect(parseTwilioSeconds('0')).toBe(0);
    expect(parseTwilioSeconds('17')).toBe(17);
    expect(parseTwilioSeconds(undefined)).toBeNull();
    expect(parseTwilioSeconds('')).toBeNull();
    expect(parseTwilioSeconds(' ')).toBeNull();
    expect(parseTwilioSeconds('-3')).toBeNull();
    expect(parseTwilioSeconds('1.5')).toBeNull();
    expect(parseTwilioSeconds('abc')).toBeNull();
  });
});

describe('applyTalkSeconds — the statement Postgres receives', () => {
  // No connection is opened — pg.Pool is lazy.
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('set: overwrites whatever is there (the <Dial action> is authoritative)', () => {
    const q = applyTalkSeconds(db, 'call-1', { mode: 'set', seconds: 37 }).toSQL();
    expect(q.sql).toContain('update "calls" set "talk_seconds" = $');
    expect(q.sql).not.toContain('is null');
    expect(q.params).toEqual(expect.arrayContaining([37, 'call-1']));
  });

  it('if_unset: only while talk_seconds is still NULL, so it never overrides the <Dial action>', () => {
    const q = applyTalkSeconds(db, 'call-1', { mode: 'if_unset', seconds: 41 }).toSQL();
    expect(q.sql).toContain('"calls"."talk_seconds" is null');
    expect(q.sql).toContain('"calls"."id" = $');
    expect(q.params).toEqual(expect.arrayContaining([41, 'call-1']));
  });
});
