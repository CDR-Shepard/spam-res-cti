/**
 * Plan 1D write-back: the AI Last Call Changes text (spec §5.5) and the Chatter post (spec §5.6). Pure and
 * deterministic. Every value is shown as given, on one line, with control characters stripped; the changes text stays
 * within the field's length and the post within the org's Lead FeedItem limit (980 characters, both objects).
 */
import { cutUtf16, wellFormed } from '../research/text.js';
import { DNC_FIELDS, type Change, type Skipped, type WritePlan } from './plan.js';

export const CHATTER_MAX = 980;
export const CHANGES_MAX = 32_000;
const PT_ZONE = 'America/Los_Angeles';
const SUMMARY_SHORT = 200;
const LINE_PART_MAX = 200;
const REFUSAL_MAX = 150;

export interface Applied {
  written: Change[];
  /** `field` (the allowlist name) lets a refused do-not-call flag get its own section (5a Fix 1, M-8). */
  notWritten: Array<{ label: string; reason: string; field?: string }>;
  created: string[];
}
export interface RenderInput {
  at: Date;
  outcomeWords: string;
  aiCallId: string;
  plan: WritePlan;
  applied: Applied;
  summary: string | null;
  appointmentWords: string | null;
  resultsUrl: string;
  /** Set when the write-back converted the Lead (Task 24). */
  conversion: { leadName: string | null; ownerName: string; adopted: boolean } | null;
  /** Set on the fallback path: why the Lead could not be converted. */
  conversionRefused: string | null;
  /** Why a Lead was not converted when no hold or "convert and book" Task was made either (the booked time passed, I-1). */
  notConverted?: string | null;
  /** Who a booked call was then transferred to (plan.bookingThen 'transferred'); null or absent reads "a rep". */
  transferredTo?: string | null;
}

const PT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: PT_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

function ptParts(at: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of PT_PARTS.formatToParts(at)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

/** "Tue Oct 6, 3:12 PM PT" */
export function ptWords(at: Date): string {
  const p = ptParts(at);
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} PT`;
}

/** "Oct 6, 3:12 PM PT" (the Chatter header). */
function ptShort(at: Date): string {
  const p = ptParts(at);
  return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} PT`;
}

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
/** Control characters other than \n removed, lone surrogates replaced. */
const strip = (s: string): string => wellFormed(s).replace(CONTROL, '');
/** One line: stripped, whitespace (newlines included) collapsed. */
const oneLine = (s: string): string => strip(s).replace(/\s+/g, ' ').trim();
const capped = (s: string, max: number): string => (s.length > max ? `${cutUtf16(s, max - 1)}…` : s);
/** An ISO or Salesforce ("+0000") date-time: shown as Pacific words (5a Fix 1, M-7). A bare date is left alone. */
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
function datetimeWords(v: string): string | null {
  if (!DATETIME.test(v)) return null;
  const at = new Date(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(at.getTime()) ? null : ptWords(at);
}
const shown = (v: string | null): string => {
  if (v === null || oneLine(v) === '') return '(blank)';
  return datetimeWords(v.trim()) ?? oneLine(v);
};

const SKIP_WORDS: Readonly<Record<Skipped['why'], string>> = {
  not_writable: "the connected Salesforce user can't edit it",
  invalid_value: "the value is not in this org's picklist",
  moved_since_research: "changed in Salesforce since the AI's research, so left alone",
  not_from_state: 'left at its current value (the AI only moves it from the usual starting values)',
};

function conversionLine(c: NonNullable<RenderInput['conversion']>): string {
  if (c.adopted) return 'The Lead was already converted; wrote to its Opportunity';
  const name = c.leadName === null || oneLine(c.leadName) === '' ? 'the Lead' : `Lead "${oneLine(c.leadName)}"`;
  return `Converted ${name} into this Opportunity (owner ${oneLine(c.ownerName)}); new Account and Contact`;
}

const section = (title: string, items: readonly string[]): string[] => (items.length > 0 ? [title, ...items.map((x) => `- ${x}`)] : []);

const DNC_TITLE = 'Could not set do-not-call flag';
const isDnc = (field: string | undefined): boolean => field !== undefined && DNC_FIELDS.has(field);

/** The do-not-call flags that were not set: plan skips and Salesforce refusals, as label and reason (M-8). */
function dncRefusals(i: RenderInput): Array<{ label: string; reason: string }> {
  return [
    ...i.plan.skipped.filter((s) => isDnc(s.field)).map((s) => ({ label: oneLine(s.label), reason: SKIP_WORDS[s.why] })),
    ...i.applied.notWritten.filter((n) => isDnc(n.field)).map((n) => ({ label: oneLine(n.label), reason: oneLine(n.reason) })),
  ];
}

const KIND_WORDS: Readonly<Record<string, string>> = { phone: 'phone consultation', walkthrough: 'walkthrough' };

/** "; then transferred to Evren" / "; then the transfer failed" when the booked call went on to a transfer (M-9). */
function thenWords(i: RenderInput): string {
  if (i.plan.bookingThen === 'transfer_failed') return '; then the transfer failed';
  if (i.plan.bookingThen !== 'transferred') return '';
  const who = i.transferredTo === undefined || i.transferredTo === null || oneLine(i.transferredTo) === '' ? 'a rep' : capped(oneLine(i.transferredTo), 80);
  return `; then transferred to ${who}`;
}

/** "Booked phone consultation Wed Oct 7, 11:00 AM PT", from the plan's booking. */
function bookedWords(plan: WritePlan): string | null {
  const b = plan.appointment?.booked;
  return b ? `${KIND_WORDS[b.kind] ?? b.kind} ${ptWords(new Date(b.start))}` : null;
}

/**
 * The AI Last Call Changes field (spec §5.5): header, a "Booked …; then transferred …" line (M-9), then Could not set
 * do-not-call flag (M-8), Changed, Created, Kept the rep's value, Not written, Not filled.
 */
export function changesFieldText(i: RenderInput): string {
  const header = `AI call on ${ptWords(i.at)} · ${oneLine(i.outcomeWords)} · AI call ${oneLine(i.aiCallId).slice(0, 8)}…`;
  const created = [...(i.conversion ? [conversionLine(i.conversion)] : []), ...i.applied.created.map(oneLine)];
  const refused = [
    ...(i.conversionRefused === null ? [] : [`Lead not converted: ${oneLine(i.conversionRefused)}; a hold and a "convert and book" Task were created instead`]),
    ...(i.notConverted === undefined || i.notConverted === null ? [] : [`Lead not converted: ${oneLine(i.notConverted)}`]),
  ];
  const booked = bookedWords(i.plan);
  const then = thenWords(i);
  const lines = [
    header,
    ...(then !== '' && booked !== null ? [`Booked ${booked}${then}`] : []),
    ...section(DNC_TITLE, dncRefusals(i).map((r) => `${r.label}: ${r.reason}`)),
    ...section('Changed', i.applied.written.map((c) => `${oneLine(c.label)}: ${shown(c.before)} → ${shown(c.after)}`)),
    ...section('Created', created),
    ...section("Kept the rep's value", i.plan.kept.map((k) => `${oneLine(k.label)}: kept "${oneLine(k.current)}" (seller said: "${oneLine(k.evidence)}")`)),
    ...section('Not written', [...refused, ...i.applied.notWritten.filter((n) => !isDnc(n.field)).map((n) => `${oneLine(n.label)}: ${oneLine(n.reason)}`)]),
    ...section('Not filled', [
      ...i.plan.skipped.filter((s) => !isDnc(s.field)).map((s) => `${oneLine(s.label)}: ${SKIP_WORDS[s.why]}`),
      ...(i.plan.mapped ? [] : ['Fill-blanks skipped: the answer mapping was unavailable']),
    ]),
  ];
  return capped(strip(lines.join('\n')), CHANGES_MAX);
}

type SummaryCut = 'full' | 'sentence' | 'short' | 'none';
interface ChatterCut {
  summary: SummaryCut;
  sellerSaid: boolean;
  changedShort: boolean;
}

function summaryText(summary: string, cut: SummaryCut): string {
  if (cut === 'full') return summary;
  const sentence = /^.*?[.!?](?=\s|$)/.exec(summary)?.[0] ?? summary;
  return cut === 'sentence' ? sentence : capped(sentence, SUMMARY_SHORT);
}

function changedLine(written: readonly Change[], short: boolean): string {
  if (written.length === 0) return 'Changed: nothing';
  if (short) return `Changed: +${written.length} changes (see AI Last Call Changes)`;
  const first = written.slice(0, 3).map((c) => `${oneLine(c.label)} → ${shown(c.after)}`);
  const more = written.length > 3 ? [`+${written.length - 3} more (see AI Last Call Changes)`] : [];
  return `Changed: ${[...first, ...more].join('; ')}`;
}

/** Every line but the URL line, for one cut level. */
function chatterHead(i: RenderInput, cut: ChatterCut): string[] {
  const summary = i.summary === null ? '' : oneLine(i.summary);
  const filled = i.applied.written.filter((c) => c.why === 'filled').slice(0, 4);
  const refused = i.conversionRefused === null ? null : capped(oneLine(i.conversionRefused), REFUSAL_MAX);
  const then = thenWords(i);
  const words = i.appointmentWords === null ? (then === '' ? null : bookedWords(i.plan)) : i.appointmentWords;
  const booked = words === null ? '' : `${capped(oneLine(words), LINE_PART_MAX)}${then}`;
  const dnc = [...new Set(dncRefusals(i).map((r) => r.label))];
  return [
    `AI call · ${ptShort(i.at)} · ${capped(oneLine(i.outcomeWords), 60)}`,
    ...(dnc.length > 0 ? [`${DNC_TITLE}: ${capped(dnc.join(', '), REFUSAL_MAX)} (see AI Last Call Changes)`] : []),
    ...(i.conversion ? ['Converted from Lead by the AI after the seller booked.'] : []),
    ...(refused === null ? [] : [`Not converted to an Opportunity (${refused}): a hold and a "convert and book" Task were created.`]),
    ...(booked === '' ? [] : [`Booked: ${booked}`]),
    ...(summary === '' || cut.summary === 'none' ? [] : [`Summary: ${summaryText(summary, cut.summary)}`]),
    ...(cut.sellerSaid && filled.length > 0 ? [`Seller said: ${filled.map((c) => `${oneLine(c.label)} ${shown(c.after)}`).join(' · ')}`] : []),
    changedLine(i.applied.written, cut.changedShort),
  ];
}

/** Cut from the bottom of the content: the summary first, then "Seller said", then the change list. */
const CUTS: readonly ChatterCut[] = [
  { summary: 'full', sellerSaid: true, changedShort: false },
  { summary: 'sentence', sellerSaid: true, changedShort: false },
  { summary: 'short', sellerSaid: true, changedShort: false },
  { summary: 'short', sellerSaid: false, changedShort: false },
  { summary: 'short', sellerSaid: false, changedShort: true },
  { summary: 'none', sellerSaid: false, changedShort: true },
];

/** The Chatter post (spec §5.6), always ≤ CHATTER_MAX and always ending with the "Call details" URL line. */
export function chatterText(i: RenderInput): string {
  const urlLine = `Call details: ${oneLine(i.resultsUrl)}`;
  for (const cut of CUTS) {
    const text = strip([...chatterHead(i, cut), urlLine].join('\n'));
    if (text.length <= CHATTER_MAX) return text;
  }
  // Only an absurd URL or header gets here: keep the URL line whole and cut the rest to fit.
  const room = CHATTER_MAX - urlLine.length - 1;
  if (room < 2) return capped(urlLine, CHATTER_MAX);
  return `${capped(strip(chatterHead(i, CUTS[CUTS.length - 1]!).join('\n')), room)}\n${urlLine}`;
}
