import { describe, expect, it } from 'vitest';
import type { GateStep, TouchChannel } from '@cti/contracts';
import { DEFAULT_ORDER, RULE, planTouch, recheckQueuedCall, type PlanDecision, type PlanInput } from './rules.js';

// Tuesday 2026-10-06, 10:00 Pacific (PDT = UTC-7): inside every window for a 415 number.
const NOW = new Date('2026-10-06T17:00:00Z');
const MOBILE = { field: 'MobilePhone', e164: '+14155550101' };
const LANDLINE = { field: 'Phone', e164: '+14155550102' };
const ALL_LIVE: ReadonlySet<TouchChannel> = new Set<TouchChannel>(['rep_call', 'ai_call', 'sms', 'email']);
const PHASE_1: ReadonlySet<TouchChannel> = new Set<TouchChannel>(['rep_call']);
const NO_AI: ReadonlySet<TouchChannel> = new Set<TouchChannel>(['rep_call', 'sms', 'email']);

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    now: NOW,
    liveChannels: ALL_LIVE,
    triageChannels: [],
    defaultOrder: [...DEFAULT_ORDER],
    phones: [MOBILE, LANDLINE],
    email: 'pat@example.com',
    consentAiCall: false,
    blocks: new Map(),
    sfDoNotCall: false,
    sfEmailOptOut: false,
    state: 'CA',
    lastChannel: null,
    touchedToday: false,
    lastHumanDialAt: null,
    ...over,
  };
}

const allBlocked = (block: 'opted_out' | 'blocked' | 'dnc') => new Map([[MOBILE.e164, block], [LANDLINE.e164, block]]);

interface Case {
  name: string;
  over: Partial<PlanInput>;
  expected: { channel: TouchChannel; status: 'planned' | 'held' } | 'exit';
  steps: Array<Partial<GateStep>>;
}

const cases: Case[] = [
  {
    name: 'triage order is respected',
    over: { triageChannels: ['email', 'call'] },
    expected: { channel: 'email', status: 'planned' },
    steps: [{ rule: RULE.order, channel: 'email,call,sms', verdict: 'kept' }, { rule: RULE.live, channel: 'email', verdict: 'kept' }],
  },
  {
    name: 'the default order applies when triage is empty',
    over: {},
    expected: { channel: 'sms', status: 'planned' },
    steps: [{ rule: RULE.order, channel: 'sms,call,email', verdict: 'kept', detail: 'No triage preference, then the default order sms, call, email' }],
  },
  {
    name: 'call → rep_call without consent, even with AI calls live',
    over: { triageChannels: ['call'], consentAiCall: false },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.callKind, channel: 'rep_call', verdict: 'kept', detail: 'No AI-call consent: a rep calls through the dialer' }],
  },
  {
    name: 'call → rep_call with consent when AI calls are not live',
    over: { triageChannels: ['call'], consentAiCall: true, liveChannels: NO_AI },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.callKind, channel: 'rep_call', verdict: 'kept', detail: 'AI calls are not live: a rep calls through the dialer' }],
  },
  {
    name: 'call → ai_call only with consent AND AI calls live',
    over: { triageChannels: ['call'], consentAiCall: true },
    expected: { channel: 'ai_call', status: 'planned' },
    steps: [{ rule: RULE.callKind, channel: 'ai_call', verdict: 'kept' }],
  },
  {
    name: 'no number removes call and sms',
    over: { phones: [] },
    expected: { channel: 'email', status: 'planned' },
    steps: [
      { rule: RULE.contactPoint, channel: 'sms', verdict: 'removed', detail: 'No mobile number on the record' },
      { rule: RULE.contactPoint, channel: 'rep_call', verdict: 'removed', detail: 'No phone number on the record' },
    ],
  },
  {
    name: 'sms needs a number from a mobile field',
    over: { phones: [LANDLINE] },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.contactPoint, channel: 'sms', verdict: 'removed', detail: 'No mobile number on the record' }],
  },
  {
    name: 'email needs an email address',
    over: { triageChannels: ['email'], email: null },
    expected: { channel: 'sms', status: 'planned' },
    steps: [{ rule: RULE.contactPoint, channel: 'email', verdict: 'removed', detail: 'No email address on the record' }],
  },
  ...(['opted_out', 'blocked', 'dnc'] as const).map((block): Case => ({
    name: `${block} on every number removes call and sms but not email`,
    over: { blocks: allBlocked(block) },
    expected: { channel: 'email', status: 'planned' },
    steps: [
      { rule: RULE.suppression, channel: 'sms', verdict: 'removed', detail: `Every mobile number is suppressed (${block})` },
      { rule: RULE.suppression, channel: 'rep_call', verdict: 'removed', detail: `Every number is suppressed (${block})` },
    ],
  })),
  {
    name: 'a block on only some numbers keeps the call',
    over: { triageChannels: ['call'], blocks: new Map([[LANDLINE.e164, 'opted_out' as const]]) },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.live, channel: 'rep_call', verdict: 'kept' }],
  },
  {
    name: 'Salesforce Do Not Call removes call and sms',
    over: { sfDoNotCall: true },
    expected: { channel: 'email', status: 'planned' },
    steps: [
      { rule: RULE.suppression, channel: 'sms', verdict: 'removed', detail: 'Salesforce Do Not Call is set' },
      { rule: RULE.suppression, channel: 'rep_call', verdict: 'removed', detail: 'Salesforce Do Not Call is set' },
    ],
  },
  {
    name: 'Salesforce Email Opt Out removes email',
    over: { triageChannels: ['email'], sfEmailOptOut: true },
    expected: { channel: 'sms', status: 'planned' },
    steps: [{ rule: RULE.suppression, channel: 'email', verdict: 'removed', detail: 'Salesforce Email Opt Out is set' }],
  },
  ...(['FL', 'OK', 'WA', 'MD'] as const).map((state): Case => ({
    name: `${state} removes sms without consent`,
    over: { state },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.textConsentState, channel: 'sms', verdict: 'removed', detail: `Texts to ${state} need the consent checkbox` }],
  })),
  ...(['FL', 'OK', 'WA', 'MD'] as const).map((state): Case => ({
    name: `${state} keeps sms with consent`,
    over: { state, consentAiCall: true },
    expected: { channel: 'sms', status: 'planned' },
    steps: [{ rule: RULE.live, channel: 'sms', verdict: 'kept' }],
  })),
  {
    name: 'rule 8 removes the channel of the last touch',
    over: { lastChannel: 'sms' },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.repeat, channel: 'sms', verdict: 'removed', detail: 'Same channel as the last touch (sms)' }],
  },
  {
    name: 'rule 8 treats an AI call and a rep call as the same channel',
    over: { triageChannels: ['sms', 'call'], consentAiCall: true, lastChannel: 'rep_call', phones: [LANDLINE] },
    expected: { channel: 'email', status: 'planned' },
    steps: [{ rule: RULE.repeat, channel: 'ai_call', verdict: 'removed' }],
  },
  {
    name: "rule 8 keeps the repeat when it is triage's first choice",
    over: { lastChannel: 'sms', triageChannels: ['sms'] },
    expected: { channel: 'sms', status: 'planned' },
    steps: [{ rule: RULE.repeat, channel: 'sms', verdict: 'kept', detail: 'Same channel as the last touch, but triage prefers sms' }],
  },
  {
    name: 'rule 8 never empties the set',
    over: { lastChannel: 'email', phones: [] },
    expected: { channel: 'email', status: 'planned' },
    steps: [{ rule: RULE.repeat, channel: 'email', verdict: 'kept', detail: 'Same channel as the last touch, but it is the only channel left' }],
  },
  {
    name: 'rule 8 never drops the only live channel (phase 1: every touch is a rep call)',
    over: { liveChannels: PHASE_1, lastChannel: 'rep_call' },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [{ rule: RULE.repeat, channel: 'rep_call', verdict: 'kept', detail: 'Same channel as the last touch, but it is the only live channel left' }],
  },
  {
    name: 'phase 1: sms-first triage with a phone → rep_call',
    over: { liveChannels: PHASE_1, triageChannels: ['sms', 'call'] },
    expected: { channel: 'rep_call', status: 'planned' },
    steps: [
      { rule: RULE.live, channel: 'sms', verdict: 'removed', detail: 'sms is not live for this tenant' },
      { rule: RULE.live, channel: 'rep_call', verdict: 'kept', detail: 'First live channel' },
    ],
  },
  {
    name: 'phase 1: an email-only person gets a held email',
    over: { liveChannels: PHASE_1, phones: [] },
    expected: { channel: 'email', status: 'held' },
    steps: [{ rule: RULE.live, channel: 'email', verdict: 'held', detail: 'email is not live yet: held until it is' }],
  },
  {
    name: 'nothing allowed → exit no_allowed_channel',
    over: { phones: [], email: null },
    expected: 'exit',
    steps: [
      { rule: RULE.contactPoint, channel: 'email', verdict: 'removed' },
      { rule: RULE.live, channel: 'none', verdict: 'removed', detail: 'No channel remains: the enrollment exits (no_allowed_channel)' },
    ],
  },
  {
    name: 'every channel suppressed → exit no_allowed_channel',
    over: { sfDoNotCall: true, sfEmailOptOut: true },
    expected: 'exit',
    steps: [{ rule: RULE.suppression, channel: 'email', verdict: 'removed' }],
  },
];

function summary(d: PlanDecision): { channel: TouchChannel; status: 'planned' | 'held' } | 'exit' {
  return d.kind === 'exit' ? 'exit' : { channel: d.channel, status: d.status };
}

describe('planTouch rules', () => {
  it.each(cases)('$name', ({ over, expected, steps }) => {
    const decision = planTouch(input(over));
    expect(summary(decision)).toEqual(expected);
    expect(decision.audit).toEqual(expect.arrayContaining(steps.map((s) => expect.objectContaining(s))));
    if (decision.kind === 'exit') expect(decision.reason).toBe('no_allowed_channel');
  });

  it('applies the rules in order: order, call kind, removals, rule 8, then rule 1', () => {
    const d = planTouch(input({ triageChannels: ['call'], phones: [LANDLINE], lastChannel: 'rep_call', state: 'FL' }));
    expect(d.audit.map((s) => `${s.rule}:${s.channel}:${s.verdict}`)).toEqual([
      'order:call,sms,email:kept',
      'rule3_call_kind:rep_call:kept',
      'rule2_contact_point:sms:removed',
      'rule8_repeat:rep_call:kept',
      'rule1_live:rep_call:kept',
    ]);
  });

  it('keeps every step a valid GateStep', () => {
    for (const c of cases) {
      for (const s of planTouch(input(c.over)).audit) {
        expect(['removed', 'deferred', 'kept', 'held']).toContain(s.verdict);
        expect(s.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('planTouch deferrals', () => {
  it('is due now, with no deferred step, inside the window', () => {
    const d = planTouch(input({ liveChannels: PHASE_1 }));
    expect(d).toMatchObject({ kind: 'touch', channel: 'rep_call', dueAt: NOW });
    expect(d.audit.filter((s) => s.verdict === 'deferred')).toEqual([]);
  });

  it('a CTI dial 3 hours ago defers the touch to 24 hours after that dial', () => {
    const now = new Date('2026-10-06T20:00:00Z'); // 13:00 PDT
    const dial = new Date('2026-10-06T17:00:00Z');
    const d = planTouch(input({ now, liveChannels: PHASE_1, lastHumanDialAt: dial }));
    if (d.kind !== 'touch') throw new Error('expected a touch');
    expect(d.dueAt.getTime()).toBeGreaterThanOrEqual(dial.getTime() + 24 * 3600_000);
    expect(d.dueAt).toEqual(new Date('2026-10-07T17:00:00Z'));
    expect(d.audit).toContainEqual(expect.objectContaining({ rule: RULE.humanDial, channel: 'rep_call', verdict: 'deferred' }));
  });

  it('a CTI dial more than 24 hours ago does not defer', () => {
    const d = planTouch(input({ liveChannels: PHASE_1, lastHumanDialAt: new Date(NOW.getTime() - 25 * 3600_000) }));
    expect(d).toMatchObject({ kind: 'touch', dueAt: NOW });
    expect(d.audit.some((s) => s.rule === RULE.humanDial)).toBe(false);
  });

  it('touched today → the next local day, at the window opening', () => {
    const d = planTouch(input({ liveChannels: PHASE_1, touchedToday: true }));
    expect(d).toMatchObject({ kind: 'touch', channel: 'rep_call', dueAt: new Date('2026-10-07T15:00:00Z') }); // Wed 08:00 PDT
    expect(d.audit).toContainEqual(expect.objectContaining({ rule: RULE.frequency, verdict: 'deferred' }));
    expect(d.audit).toContainEqual(expect.objectContaining({ rule: RULE.hours, verdict: 'deferred' }));
  });

  it('outside the call window (22:30 Pacific) → the next 08:00 Pacific', () => {
    const d = planTouch(input({ now: new Date('2026-10-07T05:30:00Z'), liveChannels: PHASE_1 }));
    expect(d).toMatchObject({ kind: 'touch', channel: 'rep_call', dueAt: new Date('2026-10-07T15:00:00Z') });
    expect(d.audit).toContainEqual(expect.objectContaining({ rule: RULE.hours, channel: 'rep_call', verdict: 'deferred' }));
  });

  it('texts use the 09:00–20:00 window', () => {
    const d = planTouch(input({ now: new Date('2026-10-06T15:30:00Z') })); // 08:30 PDT
    expect(d).toMatchObject({ kind: 'touch', channel: 'sms', dueAt: new Date('2026-10-06T16:00:00Z') }); // 09:00 PDT
  });

  it('email with no phone number is scheduled 08:00–18:00 Chicago time', () => {
    const d = planTouch(input({ now: new Date('2026-10-06T23:30:00Z'), phones: [] })); // 18:30 CDT
    expect(d).toMatchObject({ kind: 'touch', channel: 'email', dueAt: new Date('2026-10-07T13:00:00Z') }); // 08:00 CDT
  });

  it('a held touch still gets a due time', () => {
    const d = planTouch(input({ now: new Date('2026-10-07T05:30:00Z'), liveChannels: PHASE_1, phones: [] }));
    expect(d).toMatchObject({ kind: 'touch', channel: 'email', status: 'held', dueAt: new Date('2026-10-07T13:00:00Z') });
  });
});

describe('recheckQueuedCall', () => {
  const CALL = { liveChannels: PHASE_1 };

  it('queues when nothing has changed, with a kept audit step', () => {
    const r = recheckQueuedCall(input(CALL));
    expect(r).toMatchObject({ kind: 'queue' });
    expect(r.audit).toEqual([expect.objectContaining({ rule: RULE.queueRecheck, channel: 'rep_call', verdict: 'kept' })]);
  });

  const skips: Array<[string, Partial<PlanInput>, string]> = [
    ['every number opted out', { blocks: allBlocked('opted_out') }, 'suppressed'],
    ['every number on the federal list', { blocks: allBlocked('dnc') }, 'suppressed'],
    ['Salesforce Do Not Call', { sfDoNotCall: true }, 'suppressed'],
    ['no phone number left', { phones: [] }, 'no_phone_number'],
  ];
  it.each(skips)('skips for %s', (_label, over, reason) => {
    const r = recheckQueuedCall(input({ ...CALL, ...over }));
    expect(r).toMatchObject({ kind: 'skip', reason });
    expect(r.audit[0]).toMatchObject({ rule: RULE.queueRecheck, verdict: 'removed' });
  });

  it('a block on only one of two numbers still queues (a number can be called)', () => {
    expect(recheckQueuedCall(input({ ...CALL, blocks: new Map([[LANDLINE.e164, 'opted_out' as const]]) })).kind).toBe('queue');
  });

  it('defers 24 hours after a recent human dial, reusing the planner deferral', () => {
    const dial = new Date(NOW.getTime() - 3600_000); // 09:00 PDT: 24 h later is inside the window
    const r = recheckQueuedCall(input({ ...CALL, lastHumanDialAt: dial }));
    expect(r).toMatchObject({ kind: 'defer', dueAt: new Date(dial.getTime() + 24 * 3600_000) });
    expect(r.audit.map((s) => s.rule)).toEqual([RULE.humanDial, RULE.queueRecheck]);
  });

  it('defers to the next opening outside the call window', () => {
    const r = recheckQueuedCall(input({ ...CALL, now: new Date('2026-10-07T05:30:00Z') }));
    expect(r).toMatchObject({ kind: 'defer', dueAt: new Date('2026-10-07T15:00:00Z') });
    expect(r.audit.map((s) => s.rule)).toEqual([RULE.hours, RULE.queueRecheck]);
  });

  it('defers to the next local day when the person was already touched today', () => {
    expect(recheckQueuedCall(input({ ...CALL, touchedToday: true }))).toMatchObject({ kind: 'defer', dueAt: new Date('2026-10-07T15:00:00Z') });
  });
});
