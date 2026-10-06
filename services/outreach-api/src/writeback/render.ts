/**
 * Plan 1D write-back: the AI Last Call Changes text (spec §5.5) and the Chatter post (spec §5.6). Pure and
 * deterministic. Every value is shown as given, on one line, with control characters stripped; the changes text stays
 * within the field's length and the post within the org's Lead FeedItem limit (980 characters, both objects).
 */
import { cutUtf16, wellFormed } from '../research/text.js';
import type { Change, Skipped, WritePlan } from './plan.js';

export const CHATTER_MAX = 980;
export const CHANGES_MAX = 32_000;
const PT_ZONE = 'America/Los_Angeles';
const SUMMARY_SHORT = 200;
const LINE_PART_MAX = 200;
const REFUSAL_MAX = 150;

export interface Applied {
  written: Change[];
  notWritten: Array<{ label: string; reason: string }>;
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
const shown = (v: string | null): string => (v === null || oneLine(v) === '' ? '(blank)' : oneLine(v));

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

/** The AI Last Call Changes field (spec §5.5): header, then Changed, Created, Kept the rep's value, Not written, Not filled. */
export function changesFieldText(i: RenderInput): string {
  const header = `AI call on ${ptWords(i.at)} · ${oneLine(i.outcomeWords)} · AI call ${oneLine(i.aiCallId).slice(0, 8)}…`;
  const created = [...(i.conversion ? [conversionLine(i.conversion)] : []), ...i.applied.created.map(oneLine)];
  const refused = i.conversionRefused === null ? [] : [`Lead not converted: ${oneLine(i.conversionRefused)}; a hold and a "convert and book" Task were created instead`];
  const lines = [
    header,
    ...section('Changed', i.applied.written.map((c) => `${oneLine(c.label)}: ${shown(c.before)} → ${shown(c.after)}`)),
    ...section('Created', created),
    ...section("Kept the rep's value", i.plan.kept.map((k) => `${oneLine(k.label)}: kept "${oneLine(k.current)}" (seller said: "${oneLine(k.evidence)}")`)),
    ...section('Not written', [...refused, ...i.applied.notWritten.map((n) => `${oneLine(n.label)}: ${oneLine(n.reason)}`)]),
    ...section('Not filled', [
      ...i.plan.skipped.map((s) => `${oneLine(s.label)}: ${SKIP_WORDS[s.why]}`),
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
  const booked = i.appointmentWords === null ? '' : capped(oneLine(i.appointmentWords), LINE_PART_MAX);
  return [
    `AI call · ${ptShort(i.at)} · ${capped(oneLine(i.outcomeWords), 60)}`,
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
