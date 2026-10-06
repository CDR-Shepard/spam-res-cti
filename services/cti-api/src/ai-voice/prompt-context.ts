/**
 * The per-call facts the agent's instructions are built from (`Ctx`), and the
 * helpers that make record values safe to speak: one-line flattening with
 * markup stripped, the spoken street, the property phrase, the callback
 * number in words, and the fixed opening line that carries the disclosure.
 */
import { SLOT_ID, type AppointmentSlot } from '@cti/contracts';
import { approvedPlanText, neutraliseFences } from './prompt-plan.js';
import type { PromptInput } from './prompt.js';

const FIRST_NAME_MAX = 40;
const ADDRESS_MAX = 160;
const LABEL_MAX = 60;
/** The specialists' business hours are Pacific by default (plan 1D); also the last-resort seller zone. */
export const DEFAULT_SLOT_ZONE = 'America/Los_Angeles';
const NOTES_PROMPT_MAX = 3_000;
const E164 = /^\+[1-9]\d{7,14}$/;
const NANP = /^\+1(\d{3})(\d{3})(\d{4})$/;
const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'] as const;
export const TEST_CALL_LINE = 'Just so you know, this is a test call.';

/**
 * Strip markup characters (`#`, quotes, angle brackets, backticks; an
 * address's `#` has already become "unit"), collapse
 * whitespace (incl. newlines) and cap, so a record value cannot start a new
 * prompt section, close a quoted line, or open a tag.
 */
export function oneLine(s: string | null, max: number): string | null {
  if (s === null) return null;
  const flat = s.replace(/[#"<>`]/g, '').replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, max).trim() : null;
}

/**
 * Notes may contain anything: a forged fence tag must not close (or reopen)
 * the fence. Capped, keeping the newest (the tail — Tasks come newest last).
 */
function fenceSafe(notes: string): string {
  const body = neutraliseFences(notes).trim();
  if (!body) return '(no notes on file)';
  return body.length <= NOTES_PROMPT_MAX ? body : `…${body.slice(body.length - (NOTES_PROMPT_MAX - 1)).trimStart()}`;
}

/** "+15125550100" → { written: "512-555-0100", spoken: "five one two, five five five, zero one zero zero" }. */
export function phoneForms(e164: string | null): { written: string; spoken: string } | null {
  const n = e164?.trim() ?? '';
  if (!E164.test(n)) return null;
  const groups = NANP.exec(n)?.slice(1) ?? [n.slice(1)];
  const say = (g: string) => [...g].map((d) => DIGIT_WORDS[Number(d)]).join(' ');
  return { written: NANP.test(n) ? groups.join('-') : n, spoken: groups.map(say).join(', ') };
}

const STREET_SUFFIX: Readonly<Record<string, string>> = {
  st: 'Street', ave: 'Avenue', rd: 'Road', dr: 'Drive', ln: 'Lane', blvd: 'Boulevard', ct: 'Court',
  cir: 'Circle', pl: 'Place', hwy: 'Highway', pkwy: 'Parkway', ter: 'Terrace', trl: 'Trail', way: 'Way',
};

/** `#` in an address is said "unit" ("Oak St #5", "Oak St Unit #5" → "Oak St unit 5"), not dropped. */
export function unitWord(address: string | null): string | null {
  return address === null ? null : address.replace(/(?:\bunit\s*)?#\s*/gi, ' unit ');
}

/**
 * Expand the street-type abbreviation before any trailing "unit <n>" so
 * text-to-speech reads it naturally ("1234 Oak St unit 5" → "1234 Oak Street unit 5").
 */
export function spokenStreet(street: string): string {
  const u = /^(.*?)(\s+unit\s+\S+)$/i.exec(street);
  const [base, unit] = u ? [u[1]!, u[2]!] : [street, ''];
  const m = /^(.*\s)([A-Za-z]+)\.?$/.exec(base);
  const full = m ? STREET_SUFFIX[m[2]!.toLowerCase()] : undefined;
  return `${m && full ? `${m[1]}${full}` : base}${unit}`;
}

/**
 * The part of `"<street>, <city>, <state> <zip>"` a person says aloud: the
 * street when the address has one (it starts with a house number), else the
 * city when the first part is a plain place name, else nothing.
 */
export function placeOf(address: string): { street: string | null; city: string | null } {
  const first = address.split(',')[0]?.trim() ?? '';
  if (/^\d/.test(first)) return { street: spokenStreet(first), city: null };
  return { street: null, city: first && !/\d/.test(first) ? first : null };
}

/** How to refer to the property in speech — never with anything we do not know. */
export function propertyPhrase(c: { street: string | null; city: string | null }, owner: 'the' | 'your' | 'their'): string {
  if (c.street) return `${owner} property at ${c.street}`;
  return c.city ? `${owner} property in ${c.city}` : `${owner} property`;
}

export interface Ctx {
  agent: string;
  company: string;
  first: string | null;
  address: string | null;
  street: string | null;
  city: string | null;
  isTest: boolean;
  localTime: string;
  notes: string;
  phone: { written: string; spoken: string } | null;
  plan: string | null;
  /** A returning seller (plan 1D): only with a usable plan, which says when we last talked. */
  returning: boolean;
  /** The appointment times to offer, specialist first names sanitised; malformed slots dropped. */
  slots: AppointmentSlot[];
  /** The seller's zone: the number dialed, else the first slot's, else Pacific. Always a zone Intl accepts. */
  sellerTz: string;
}

/** Is `tz` an IANA zone this runtime can format in? */
function isZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The record's address flattened for speech (`#` said "unit"). */
const spokenAddress = (address: string | null): string | null => oneLine(unitWord(address), ADDRESS_MAX);

/**
 * Slots as the prompt renders them: a valid id and real times only, the first name flattened like any record value. The
 * stream session builds the book_appointment enum and the bookable list from this same list (Fix 1, M-2).
 * A walkthrough needs a street to confirm with the seller (final review I-1): without one, walkthrough slots are dropped
 * here, so the prompt, the tool enum and the bookable list all lose them together. Phone slots are unaffected.
 */
export function promptSlots(slots: readonly AppointmentSlot[] | undefined, address: string | null): AppointmentSlot[] {
  const spoken = spokenAddress(address);
  const hasStreet = spoken !== null && placeOf(spoken).street !== null;
  return (slots ?? [])
    .filter((s) => SLOT_ID.test(s.id) && Number.isFinite(Date.parse(s.start)) && Number.isFinite(Date.parse(s.end)) && isZone(s.timeZone))
    .filter((s) => s.kind !== 'walkthrough' || hasStreet)
    .map((s) => ({ ...s, specialistFirstName: oneLine(s.specialistFirstName, FIRST_NAME_MAX) }));
}

export function context(p: PromptInput): Ctx {
  const address = spokenAddress(p.address);
  const plan = approvedPlanText(p.approvedPlan);
  const slots = promptSlots(p.slots, p.address);
  return {
    agent: oneLine(p.agentName, LABEL_MAX) ?? 'Alex',
    company: oneLine(p.companyName, LABEL_MAX) ?? 'our company',
    first: oneLine(p.firstName, FIRST_NAME_MAX),
    address,
    ...(address ? placeOf(address) : { street: null, city: null }),
    isTest: p.isTest,
    localTime: oneLine(p.localTime, LABEL_MAX) ?? 'unknown',
    notes: fenceSafe(p.notes),
    phone: phoneForms(p.callbackNumber),
    plan,
    returning: p.returning === true && plan !== null,
    slots,
    sellerTz: [p.sellerTimeZone, slots[0]?.timeZone].find(isZone) ?? DEFAULT_SLOT_ZONE,
  };
}

/** The first thing the agent says: disclosure first, then who it is trying to reach. */
export function openingLine(c: Ctx): string {
  const disclosure = `Hi, this is ${c.agent}, an AI assistant calling for ${c.company} on a recorded line`;
  const who = c.first
    ? `is this ${c.first}?`
    : c.street
      ? `am I speaking with the owner of ${c.street}?`
      : "is this the homeowner I'm trying to reach?";
  if (!c.isTest) return `${disclosure} — ${who}`;
  return `${disclosure}. ${TEST_CALL_LINE} ${who.charAt(0).toUpperCase()}${who.slice(1)}`;
}
