/**
 * The touch planner's rules (spec §7.2). Pure: no clock, no database.
 *
 * The AI proposes an order of channels; these rules decide. Every rule that
 * looks at a channel appends a GateStep to the audit, which is stored on the
 * touch and shown in the campaign's plan view, so an admin can see why a
 * channel won, lost, waited, or was held.
 */
import {
  CALL_WINDOW,
  EMAIL_WINDOW,
  TEXT_WINDOW,
  isDailyCapped,
  nextWindowOpening,
  type ConsentBlock,
  type LocalWindow,
} from '@cti/firewall';
import type { ContactChannel, GateStep, TouchChannel } from '@cti/contracts';
import { nextLocalDayStart, nextLocalOpening, recipientTimezone } from './local-time.js';

/** The campaign default order when triage has no preference (spec §7.2). */
export const DEFAULT_ORDER: readonly ContactChannel[] = ['sms', 'call', 'email'];
/** A CTI dial in the last 24 hours defers the touch until 24 hours after that dial. */
export const HUMAN_DIAL_DEFER_MS = 24 * 60 * 60 * 1000;

/** GateStep.rule values. Numbered after spec §7.2. */
export const RULE = {
  order: 'order',
  live: 'rule1_live',
  contactPoint: 'rule2_contact_point',
  callKind: 'rule3_call_kind',
  suppression: 'rule4_suppression',
  textConsentState: 'rule5_text_consent_state',
  hours: 'rule6_hours',
  frequency: 'rule7_frequency',
  repeat: 'rule8_repeat',
  humanDial: 'human_dial',
} as const;

export interface PlanInput {
  now: Date;
  liveChannels: ReadonlySet<'rep_call' | 'ai_call' | 'sms' | 'email'>;
  triageChannels: Array<'call' | 'sms' | 'email'>; // triage order; [] = no preference
  defaultOrder: Array<'call' | 'sms' | 'email'>; // ['sms','call','email']
  phones: Array<{ field: string; e164: string }>;
  email: string | null;
  consentAiCall: boolean;
  blocks: ReadonlyMap<string, ConsentBlock>;
  sfDoNotCall: boolean;
  sfEmailOptOut: boolean;
  state: string | null; // two-letter, from record or area code
  lastChannel: 'ai_call' | 'rep_call' | 'sms' | 'email' | null;
  touchedToday: boolean; // any touch to this person sent today (recipient-local) in any campaign
  lastHumanDialAt: Date | null; // latest CTI dial to any of the person's numbers
}

export type PlanDecision =
  | { kind: 'touch'; channel: 'ai_call' | 'rep_call' | 'sms' | 'email'; status: 'planned' | 'held'; dueAt: Date; audit: GateStep[] }
  | { kind: 'exit'; reason: 'no_allowed_channel'; audit: GateStep[] };

interface Stage {
  channels: TouchChannel[];
  steps: GateStep[];
}

type Phone = PlanInput['phones'][number];

const step = (rule: string, channel: string, verdict: GateStep['verdict'], detail: string): GateStep => ({ rule, channel, verdict, detail });
const kindOf = (c: TouchChannel): ContactChannel => (c === 'ai_call' || c === 'rep_call' ? 'call' : c);
/** Same test as the campaign preview (A6): a text needs a number from a field whose name contains `Mobile`. */
export const isMobileField = (field: string): boolean => field.includes('Mobile');
const isMobile = (p: Phone): boolean => isMobileField(p.field);
const BLOCK_ORDER: readonly ConsentBlock[] = ['opted_out', 'blocked', 'dnc'];

/** Candidates: triage order first, then the rest of the default order. */
function candidateOrder(input: PlanInput): { order: ContactChannel[]; steps: GateStep[] } {
  const order = [...new Set<ContactChannel>([...input.triageChannels, ...input.defaultOrder])];
  const source = input.triageChannels.length > 0 ? `Triage order ${input.triageChannels.join(', ')}` : 'No triage preference';
  return { order, steps: [step(RULE.order, order.join(','), 'kept', `${source}, then the default order ${input.defaultOrder.join(', ')}`)] };
}

/** Rule 3: a call is an AI call only when AI calls are live AND the consent box is ticked. */
function applyCallKind(order: readonly ContactChannel[], input: PlanInput): Stage {
  const channels = (callAs: TouchChannel): TouchChannel[] => order.map((c) => (c === 'call' ? callAs : c));
  if (!order.includes('call')) return { channels: channels('rep_call'), steps: [] };
  const aiLive = input.liveChannels.has('ai_call');
  if (aiLive && input.consentAiCall) {
    return { channels: channels('ai_call'), steps: [step(RULE.callKind, 'ai_call', 'kept', 'AI-call consent is on record and AI calls are live')] };
  }
  const why = aiLive ? 'No AI-call consent' : 'AI calls are not live';
  return { channels: channels('rep_call'), steps: [step(RULE.callKind, 'rep_call', 'kept', `${why}: a rep calls through the dialer`)] };
}

function removeWhere(stage: Stage, rule: string, reasonFor: (c: TouchChannel) => string | null): Stage {
  const removed = stage.channels.flatMap((c) => {
    const reason = reasonFor(c);
    return reason ? [step(rule, c, 'removed', reason)] : [];
  });
  const gone = new Set(removed.map((s) => s.channel));
  return { channels: stage.channels.filter((c) => !gone.has(c)), steps: [...stage.steps, ...removed] };
}

/** Rule 2: no usable contact point. */
function contactPointGap(c: TouchChannel, input: PlanInput): string | null {
  if (kindOf(c) === 'call') return input.phones.length > 0 ? null : 'No phone number on the record';
  if (c === 'sms') return input.phones.some(isMobile) ? null : 'No mobile number on the record';
  return input.email ? null : 'No email address on the record';
}

/** Rule 4: opted out, block-listed, federal DNC, or the Salesforce flags. */
function suppression(c: TouchChannel, input: PlanInput): string | null {
  if (c === 'email') return input.sfEmailOptOut ? 'Salesforce Email Opt Out is set' : null;
  if (input.sfDoNotCall) return 'Salesforce Do Not Call is set';
  const pool = c === 'sms' ? input.phones.filter(isMobile) : input.phones;
  if (pool.length === 0 || !pool.every((p) => input.blocks.has(p.e164))) return null;
  const reasons = BLOCK_ORDER.filter((b) => pool.some((p) => input.blocks.get(p.e164) === b));
  return `Every ${c === 'sms' ? 'mobile ' : ''}number is suppressed (${reasons.join(', ')})`;
}

/** Rule 5: no text to FL, OK, WA, or MD without the consent checkbox. */
function textConsentState(c: TouchChannel, input: PlanInput): string | null {
  if (c !== 'sms' || input.consentAiCall || !isDailyCapped(input.state)) return null;
  return `Texts to ${input.state?.toUpperCase()} need the consent checkbox`;
}

/**
 * Rule 8: not the same channel as the last touch — unless triage's first
 * choice is that channel, and never when dropping it would leave no channel or
 * no live channel (phase 1 has one live channel, so every touch is a rep call).
 */
function applyRepeat(stage: Stage, input: PlanInput): Stage {
  const last = input.lastChannel;
  const repeat = last ? stage.channels.find((c) => kindOf(c) === kindOf(last)) : undefined;
  if (!last || !repeat) return stage;
  const keep = (detail: string): Stage => ({ channels: stage.channels, steps: [...stage.steps, step(RULE.repeat, repeat, 'kept', detail)] });
  if (input.triageChannels[0] === kindOf(last)) return keep(`Same channel as the last touch, but triage prefers ${kindOf(last)}`);
  const rest = stage.channels.filter((c) => c !== repeat);
  if (rest.length === 0) return keep('Same channel as the last touch, but it is the only channel left');
  if (input.liveChannels.has(repeat) && !rest.some((c) => input.liveChannels.has(c))) {
    return keep('Same channel as the last touch, but it is the only live channel left');
  }
  return { channels: rest, steps: [...stage.steps, step(RULE.repeat, repeat, 'removed', `Same channel as the last touch (${last})`)] };
}

/** Rule 1: the first remaining live channel wins; none live → held on the first remaining. */
function pickChannel(stage: Stage, input: PlanInput): { channel: TouchChannel; status: 'planned' | 'held'; steps: GateStep[] } | null {
  const [first] = stage.channels;
  if (!first) return null;
  const winner = stage.channels.find((c) => input.liveChannels.has(c));
  if (!winner) {
    return { channel: first, status: 'held', steps: [...stage.steps, step(RULE.live, first, 'held', `${first} is not live yet: held until it is`)] };
  }
  const passed = stage.channels.slice(0, stage.channels.indexOf(winner)).map((c) => step(RULE.live, c, 'removed', `${c} is not live for this tenant`));
  return { channel: winner, status: 'planned', steps: [...stage.steps, ...passed, step(RULE.live, winner, 'kept', 'First live channel')] };
}

/** The number the touch goes to (calls/texts) or the number whose zone schedules an email. */
function targetNumber(channel: TouchChannel, input: PlanInput): string | null {
  if (channel === 'email') return input.phones[0]?.e164 ?? null;
  const pool = channel === 'sms' ? input.phones.filter(isMobile) : input.phones;
  return (pool.find((p) => !input.blocks.has(p.e164)) ?? pool[0])?.e164 ?? null;
}

function windowFor(channel: TouchChannel): LocalWindow {
  if (channel === 'sms') return TEXT_WINDOW;
  if (channel === 'email') return EMAIL_WINDOW;
  return CALL_WINDOW;
}

/** Rules 6 and 7 plus the human-dial deferral: they move the due time, never remove a channel. */
function schedule(channel: TouchChannel, input: PlanInput): { dueAt: Date; steps: GateStep[] } {
  const number = targetNumber(channel, input);
  const timezone = recipientTimezone(number);
  const dialUntil = input.lastHumanDialAt ? new Date(input.lastHumanDialAt.getTime() + HUMAN_DIAL_DEFER_MS) : null;
  const afterDial = dialUntil && dialUntil > input.now ? dialUntil : input.now;
  const tomorrow = input.touchedToday ? nextLocalDayStart(input.now, timezone) : null;
  const start = tomorrow && tomorrow > afterDial ? tomorrow : afterDial;
  const window = windowFor(channel);
  const dueAt = number ? nextWindowOpening(number, start, window) : nextLocalOpening(start, timezone, window);
  const steps = [
    ...(afterDial > input.now ? [step(RULE.humanDial, channel, 'deferred', `A rep dialed this person at ${input.lastHumanDialAt?.toISOString()}; waiting 24 hours`)] : []),
    ...(start > afterDial ? [step(RULE.frequency, channel, 'deferred', 'Already touched today: waiting for the next local day')] : []),
    ...(dueAt > start ? [step(RULE.hours, channel, 'deferred', `Outside ${window.start}-${window.endExclusive} recipient-local: next opening ${dueAt.toISOString()}`)] : []),
  ];
  return { dueAt, steps };
}

export function planTouch(input: PlanInput): PlanDecision {
  const ordered = candidateOrder(input);
  const typed = applyCallKind(ordered.order, input);
  const reachable = removeWhere({ channels: typed.channels, steps: [...ordered.steps, ...typed.steps] }, RULE.contactPoint, (c) => contactPointGap(c, input));
  const allowed = removeWhere(reachable, RULE.suppression, (c) => suppression(c, input));
  const lawful = removeWhere(allowed, RULE.textConsentState, (c) => textConsentState(c, input));
  const varied = applyRepeat(lawful, input);
  const picked = pickChannel(varied, input);
  if (!picked) {
    return { kind: 'exit', reason: 'no_allowed_channel', audit: [...varied.steps, step(RULE.live, 'none', 'removed', 'No channel remains: the enrollment exits (no_allowed_channel)')] };
  }
  const timing = schedule(picked.channel, input);
  return { kind: 'touch', channel: picked.channel, status: picked.status, dueAt: timing.dueAt, audit: [...picked.steps, ...timing.steps] };
}
