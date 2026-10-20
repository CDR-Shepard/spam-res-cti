/**
 * The agent's instructions, voicemail and inbound prompt as Mustache templates (plan 2026-10-16 editable agent prompts;
 * the inbound kind, plan 2026-10-16 inbound agent testing):
 * the placeholders each kind may use, rendering over one call's data, and the check an admin's draft must
 * pass before it is saved.
 *
 * Mustache rules: no HTML escaping (`escape: (s) => s`; the global `Mustache.escape` is never touched), no
 * partials (`{{> x}}` is an unknown placeholder), and the view holds only strings, booleans and lists of
 * string records (prompt-view.ts), inserted literally. Each render and check uses a fresh Mustache.Writer
 * instead of the global one, so the drafts an admin previews never pile up in Mustache's template cache.
 */
import Mustache from 'mustache';
import { AGENT_PROMPT_MAX_CHARS, type AgentPromptCheck, type AgentPromptKind, type AgentPromptPlaceholder } from '@cti/contracts';
import { DEFAULT_INBOUND_TEMPLATE } from './prompt-default-inbound.js';
import { DEFAULT_INSTRUCTIONS_TEMPLATE } from './prompt-default-instructions.js';
import { DEFAULT_VOICEMAIL_TEMPLATE } from './prompt-default-voicemail.js';
import { promptView } from './prompt-view.js';
import type { PromptInput } from './prompt.js';

export const DEFAULT_TEMPLATES: Readonly<Record<AgentPromptKind, string>> = {
  instructions: DEFAULT_INSTRUCTIONS_TEMPLATE,
  voicemail: DEFAULT_VOICEMAIL_TEMPLATE,
  inbound: DEFAULT_INBOUND_TEMPLATE,
};

const text = (name: string, description: string): AgentPromptPlaceholder => ({ name, kind: 'text', description });
const section = (name: string, description: string): AgentPromptPlaceholder => ({ name, kind: 'section', description });
/** A text placeholder the default also uses as a block, to show words only when the value is there. */
const shownWhen = (name: string, description: string, when: string): AgentPromptPlaceholder =>
  text(name, `${description} — also works as {{#${name}}}…{{/${name}}} to show text only when ${when}`);

const AGENT_NAME = text('agent_name', 'the name the agent introduces itself with (e.g. "Alex")');
const COMPANY_NAME = text('company_name', 'your company\'s name as the agent says it (e.g. "GG Homes")');
const FIRST_NAME = shownWhen('first_name', "the person's first name from Salesforce (empty when unknown)", "it's known");
const YOUR_PROPERTY = text(
  'your_property',
  '"your property at 1234 Oak Street" — or "your property in Tampa" when only the city is known, or just "your property"',
);
const LOCAL_TIME = text('local_time', 'the person\'s local date and time when the call starts, e.g. "Tuesday, October 6, 2026, 4:12 PM"');
const CALLER_NUMBER = text('caller_number', 'the number the caller is calling from, written like 619-555-0100');
const CALLBACK_NUMBER = shownWhen(
  'callback_number',
  'the number people can call us back on, written like "512-555-0100" (empty when there is none)',
  'there is one',
);

/** What a template may use, per kind: text = a value (`{{name}}`), section = a block shown or hidden (`{{#name}}…{{/name}}`). */
export const PLACEHOLDERS: Readonly<Record<AgentPromptKind, readonly AgentPromptPlaceholder[]>> = {
  instructions: [
    AGENT_NAME,
    COMPANY_NAME,
    FIRST_NAME,
    shownWhen('address', "the property's full address from Salesforce, on one line (empty when unknown)", "it's known"),
    shownWhen(
      'street',
      'the street part of the address as it is said out loud, e.g. "1234 Oak Street" (empty when the address has no street)',
      'there is one',
    ),
    shownWhen(
      'spoken_address',
      'what to call the property out loud: the street, or the city when there is no street (empty when neither is known)',
      'there is one',
    ),
    text('the_property', '"the property at 1234 Oak Street" — or "the property in Tampa" when only the city is known, or just "the property"'),
    text('their_property', '"their property at 1234 Oak Street" — or "their property in Tampa" when only the city is known, or just "their property"'),
    YOUR_PROPERTY,
    LOCAL_TIME,
    text('crm_notes', 'the person\'s Salesforce notes and recent activity, cleaned up and cut to the newest 3,000 characters ("(no notes on file)" when there are none)'),
    CALLBACK_NUMBER,
    text('callback_number_spoken', 'the callback number in words, e.g. "five one two, five five five, zero one zero zero" (empty when there is none)'),
    section('call_plan', 'the call plan your team approved for this call: {{#call_plan}}…{{/call_plan}} shows a block only when there is one, and {{call_plan}} inside it is the plan itself'),
    section('is_test', 'on for a test call placed from the app: {{#is_test}}…{{/is_test}} shows a block only then, {{^is_test}}…{{/is_test}} only on real calls'),
    section('returning', 'on when we have spoken with this person before and the call plan says so: {{#returning}}…{{/returning}} shows a block only then'),
    section('can_book', 'on when this call has appointment times the agent may book: {{#can_book}}…{{/can_book}} shows a block only then'),
    section('can_book_any', 'on when the agent may book anything on this call — appointment times or a high-priority visit: {{#can_book_any}}…{{/can_book_any}} shows a block only then'),
    section('offers_phone_call', 'on when the appointment times include phone consultations'),
    section('offers_walkthrough', 'on when the appointment times include in-person consultations at the house (only offered when the address has a street)'),
    shownWhen('specialist_name', 'the first name of the specialist on the first appointment time that names one, e.g. "Blake" (empty when unknown)', "it's known"),
    section('appointment_times', 'the times the agent may book: {{#appointment_times}}…{{/appointment_times}} repeats its block once for each time'),
    text('time_id', 'inside appointment_times: the code the agent books the time by, e.g. "p1"'),
    text('time_kind', 'inside appointment_times: "phone consultation" or "in-person consultation"'),
    shownWhen('time_with', 'inside appointment_times: the first name of the specialist that time is with, e.g. "Blake" (empty when unknown)', "it's known"),
    text('time_text', 'inside appointment_times: the day and time in the person\'s time zone, e.g. "Wednesday, October 7 at 2 PM their time, 11 AM Pacific"'),
    section('can_book_priority', 'on when the agent may book a high-priority in-person visit (only offered when the address has a street): {{#can_book_priority}}…{{/can_book_priority}} shows a block only then'),
    text('priority_specialist_name', 'the first name of the specialist who takes high-priority visits, e.g. "Grant" ("our specialist" when unknown; empty without a high-priority visit to offer)'),
    text('priority_default_text', 'the high-priority visit time to offer when the person names none, in their time zone, e.g. "Tuesday, October 20 at 9 AM" (empty without a high-priority visit to offer)'),
    section('had_consultation', 'on when we have met with this person before (an earlier consultation is on file): {{#had_consultation}}…{{/had_consultation}} shows a block only then'),
    text('last_consultation_when', 'the day of their earlier consultation in their time zone, e.g. "March 12", with the year when it was another year, e.g. "March 12, 2025" (empty when there was none)'),
    shownWhen('last_consultation_with', 'the first name of who their earlier consultation was with, e.g. "Blake" (empty when unknown)', "it's known"),
    section('last_consultation_in_person', 'on when their earlier consultation was in person: {{^last_consultation_in_person}}…{{/last_consultation_in_person}} shows a block when it was by phone (or there was none)'),
    section('has_booked_consultation', 'on when they already have a consultation booked: {{#has_booked_consultation}}…{{/has_booked_consultation}} shows a block only then'),
    text('booked_consultation_text', 'their booked consultation in their time zone, e.g. "Wednesday, October 21 at 11 AM with Seth, in person" or "…, by phone" (empty when there is none)'),
  ],
  voicemail: [FIRST_NAME, AGENT_NAME, COMPANY_NAME, YOUR_PROPERTY, CALLBACK_NUMBER],
  inbound: [AGENT_NAME, COMPANY_NAME, CALLER_NUMBER, LOCAL_TIME],
};

const GRANT = '0058X00000Fsx39QAB';
const BLAKE = '0058X00000FA8tLQAT';
const SETH = '0055f000005qXVfAAM';

/**
 * The preview's sample call: Jane at 1234 Oak St in Tampa, spoken with before, met in person by Blake in March, with a plan,
 * a phone time with Seth and an in-person time with Blake, a high-priority visit with Grant, and a callback number; for the
 * inbound prompt, a caller calling from 619-555-0100.
 */
export const SAMPLE_INPUT: PromptInput = {
  agentName: 'Alex',
  companyName: 'GG Homes',
  firstName: 'Jane',
  address: '1234 Oak St, Tampa, FL 33601',
  notes: 'Notes: Inherited the house from her mother; roof leaks.\nTask 2026-09-01 — Call: said maybe in spring',
  isTest: false,
  localTime: 'Tuesday, October 6, 2026, 4:12 PM',
  callbackNumber: '+15125550100',
  approvedPlan: 'Opener: Remind them we last spoke in the spring about the roof.\n\nQuestions:\n- Is the roof still leaking?',
  returning: true,
  slots: [
    {
      id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T19:00:00.000Z',
      specialistSfUserId: SETH, specialistFirstName: 'Seth', timeZone: 'America/Los_Angeles', region: 'SD',
    },
    {
      id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z',
      specialistSfUserId: BLAKE, specialistFirstName: 'Blake', timeZone: 'America/Los_Angeles', region: 'LA',
    },
  ],
  sellerTimeZone: 'America/New_York',
  consultations: { last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' }, next: null },
  priority: { specialistSfUserId: GRANT, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-07T16:00:00.000Z' },
  callerNumber: '+16195550100',
};

const NUMBER = new Intl.NumberFormat('en-US');
const VALUE_TAGS = new Set(['name', '&']);
const SECTION_TAGS = new Set(['#', '^']);
/** Placeholders whose value is yes/no or a list: printed as a value they'd read "true" or garble the prompt. */
const BLOCK_ONLY: ReadonlySet<string> = new Set([
  'is_test',
  'returning',
  'can_book',
  'can_book_any',
  'offers_phone_call',
  'offers_walkthrough',
  'appointment_times',
  'can_book_priority',
  'had_consultation',
  'last_consultation_in_person',
  'has_booked_consultation',
]);
/** Sections that repeat their block once per item: opened inside themselves they multiply the text (2^depth), so that is refused. */
const LIST_SECTIONS: ReadonlySet<string> = new Set(['appointment_times']);
/** How deep sections may nest; past it the check stops reading (no recursion into a template built to overflow the stack). */
const MAX_SECTION_DEPTH = 8;
const NO_ESCAPE = { escape: (value: string) => value };

/** The longest text a template may render to: twice its size limit (the instructions' notes and plan make a render longer than its template). */
export const renderMaxChars = (kind: AgentPromptKind): number => 2 * AGENT_PROMPT_MAX_CHARS[kind];

/** A Mustache token: [type, value, start, end, sub-tokens (sections), ...]. */
type Token = readonly [string, string, number, number, ...unknown[]];

const lineAt = (template: string, index: number): number => template.slice(0, index).split('\n').length;

/**
 * Where the section Mustache says is never closed opens. Mustache reports the end of the template, so replay
 * the section tags (default delimiters): the innermost one still open at the end is the one it names.
 */
function unclosedSectionAt(template: string, name: string): number | null {
  const open: Array<{ name: string; at: number }> = [];
  for (const m of template.matchAll(/\{\{\s*([#^/])\s*([^{}]*?)\s*\}\}/g)) {
    if (m[1] === '/') open.pop();
    else open.push({ name: m[2] ?? '', at: m.index ?? 0 });
  }
  const last = open.at(-1);
  return last?.name === name ? last.at : null;
}

/** Where the tag with no closing `}}` starts: the last `{{` with no `}}` after it (Mustache reports the end). */
function unclosedTagAt(template: string): number | null {
  const at = template.lastIndexOf('{{');
  return at >= 0 && !template.includes('}}', at + 2) ? at : null;
}

/** Mustache's parse error in plain words, with its line (from the character position the message ends with). */
function parseProblem(template: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = / at (\d+)$/.exec(message);
  const raw = at ? message.slice(0, at.index) : message;
  const unclosed = /^Unclosed section "(.*)"$/.exec(raw);
  const unopened = /^Unopened section "(.*)"$/.exec(raw);
  const reported = at ? Number(at[1]) : null;
  const atEnd = reported === template.length;
  const index = unclosed && atEnd
    ? (unclosedSectionAt(template, unclosed[1] ?? '') ?? reported)
    : raw === 'Unclosed tag' && atEnd
      ? (unclosedTagAt(template) ?? reported)
      : reported;
  const what = unclosed
    ? `Section "${unclosed[1]}" is never closed — add {{/${unclosed[1]}}}`
    : unopened
      ? `{{/${unopened[1]}}} closes a section that was never opened`
      : raw === 'Unclosed tag'
        ? 'A tag is missing its closing }}'
        : `The prompt can't be read: ${raw}`;
  return index === null ? what : `${what} (line ${lineAt(template, index)})`;
}

/** What is wrong with one tag, if anything: a partial or an unknown name, or a yes/no or list placeholder used as a value. */
function tagProblem(type: string, name: string, known: ReadonlySet<string>): string | null {
  if (type === '>') return `Unknown placeholder: > ${name}`;
  if (!VALUE_TAGS.has(type) && !SECTION_TAGS.has(type)) return null;
  if (!known.has(name)) return `Unknown placeholder: ${name}`;
  return VALUE_TAGS.has(type) && BLOCK_ONLY.has(name) ? `${name} is a section — use {{#${name}}}…{{/${name}}}` : null;
}

/** What is wrong with opening section `name` inside the sections already `open` (outermost first), if anything. */
function nestingProblem(name: string, open: readonly string[]): string | null {
  if (open.length >= MAX_SECTION_DEPTH) return `Sections are nested too deeply (more than ${MAX_SECTION_DEPTH} levels)`;
  return LIST_SECTIONS.has(name) && open.includes(name) ? `${name} can't be nested inside itself` : null;
}

/** Every tag problem, walking into sections (never deeper than MAX_SECTION_DEPTH), in template order. */
function tagProblems(tokens: readonly Token[], known: ReadonlySet<string>, open: readonly string[] = []): string[] {
  return tokens.flatMap((t) => {
    const own = tagProblem(t[0], t[1], known);
    const isSection = SECTION_TAGS.has(t[0]) && Array.isArray(t[4]);
    const nesting = isSection ? nestingProblem(t[1], open) : null;
    // Past the depth cap nothing inside is read: the section is refused as a whole.
    const tooDeep = isSection && open.length >= MAX_SECTION_DEPTH;
    const inner = isSection && !tooDeep ? tagProblems(t[4] as Token[], known, [...open, t[1]]) : [];
    return [...(own === null ? [] : [own]), ...(nesting === null ? [] : [nesting]), ...inner];
  });
}

/** Why `template` can't be used for `kind` (empty when it can): size, then syntax or placeholder problems. */
function templateProblems(kind: AgentPromptKind, template: string, writer: Mustache.Writer): string[] {
  if (template.trim() === '') return ['Prompt is empty'];
  const max = AGENT_PROMPT_MAX_CHARS[kind];
  const size = template.length > max ? [`Prompt is longer than ${NUMBER.format(max)} characters`] : [];
  let tokens: Token[];
  try {
    tokens = writer.parse(template) as Token[];
  } catch (err) {
    return [...size, parseProblem(template, err)];
  }
  const known = new Set(PLACEHOLDERS[kind].map((p) => p.name));
  return [...size, ...new Set(tagProblems(tokens, known))];
}

/**
 * `template` rendered over one call's data. Throws when the check would refuse the template (the message never
 * repeats the template), so a caller can fall back to the default.
 */
export function renderPrompt(kind: AgentPromptKind, template: string, input: PromptInput): string {
  const writer = new Mustache.Writer();
  const problems = templateProblems(kind, template, writer);
  if (problems.length > 0) throw new Error(`The ${kind} template was refused (${problems.length} problem(s))`);
  return writer.render(template, promptView(input), undefined, NO_ESCAPE);
}

/** The sample render for a checked template, or the problem that stopped it (a check never throws). */
function sampleRender(kind: AgentPromptKind, writer: Mustache.Writer, template: string): { rendered: string | null; problems: string[] } {
  let rendered: string;
  try {
    rendered = writer.render(template, promptView(SAMPLE_INPUT), undefined, NO_ESCAPE);
  } catch {
    return { rendered: null, problems: ["The prompt couldn't be rendered for the sample call"] };
  }
  // A prompt that comes out empty would leave a call with no script (or a silent voicemail): refused here, replaced by the default on a call.
  if (rendered.trim() === '') return { rendered: null, problems: ['The prompt comes out empty for the sample call'] };
  const max = renderMaxChars(kind);
  if (rendered.length > max) return { rendered: null, problems: [`The prompt comes out too long for the sample call (over ${NUMBER.format(max)} characters)`] };
  return { rendered, problems: [] };
}

/**
 * The check behind save and preview: the kind's default and placeholders, the plain-words problems with
 * `template` (null = the default), and — only when there are none — the template rendered over SAMPLE_INPUT.
 * It never throws: anything that stops the sample render is reported as a problem.
 */
export function checkTemplate(kind: AgentPromptKind, template: string | null): AgentPromptCheck {
  const defaultTemplate = DEFAULT_TEMPLATES[kind];
  const body = template ?? defaultTemplate;
  const writer = new Mustache.Writer();
  const problems = templateProblems(kind, body, writer);
  const result = problems.length > 0 ? { rendered: null, problems } : sampleRender(kind, writer, body);
  return { defaultTemplate, placeholders: PLACEHOLDERS[kind].map((p) => ({ ...p })), ...result };
}
