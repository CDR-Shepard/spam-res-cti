/**
 * The agent's instructions and voicemail as Mustache templates (plan 2026-10-16 editable agent prompts):
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
import { DEFAULT_INSTRUCTIONS_TEMPLATE } from './prompt-default-instructions.js';
import { DEFAULT_VOICEMAIL_TEMPLATE } from './prompt-default-voicemail.js';
import { promptView } from './prompt-view.js';
import type { PromptInput } from './prompt.js';

export const DEFAULT_TEMPLATES: Readonly<Record<AgentPromptKind, string>> = {
  instructions: DEFAULT_INSTRUCTIONS_TEMPLATE,
  voicemail: DEFAULT_VOICEMAIL_TEMPLATE,
};

const text = (name: string, description: string): AgentPromptPlaceholder => ({ name, kind: 'text', description });
const section = (name: string, description: string): AgentPromptPlaceholder => ({ name, kind: 'section', description });

const AGENT_NAME = text('agent_name', 'the name the agent introduces itself with (e.g. "Alex")');
const COMPANY_NAME = text('company_name', 'your company\'s name as the agent says it (e.g. "GG Homes")');
const FIRST_NAME = text('first_name', "the person's first name from Salesforce (empty when unknown)");
const YOUR_PROPERTY = text(
  'your_property',
  '"your property at 1234 Oak Street" — or "your property in Tampa" when only the city is known, or just "your property"',
);
const CALLBACK_NUMBER = text('callback_number', 'the number people can call us back on, written like "512-555-0100" (empty when there is none)');

/** What a template may use, per kind: text = a value (`{{name}}`), section = a block shown or hidden (`{{#name}}…{{/name}}`). */
export const PLACEHOLDERS: Record<AgentPromptKind, AgentPromptPlaceholder[]> = {
  instructions: [
    AGENT_NAME,
    COMPANY_NAME,
    FIRST_NAME,
    text('address', "the property's full address from Salesforce, on one line (empty when unknown)"),
    text('street', 'the street part of the address as it is said out loud, e.g. "1234 Oak Street" (empty when the address has no street)'),
    text('spoken_address', 'what to call the property out loud: the street, or the city when there is no street (empty when neither is known)'),
    text('the_property', '"the property at 1234 Oak Street" — or "the property in Tampa" when only the city is known, or just "the property"'),
    text('their_property', '"their property at 1234 Oak Street" — or "their property in Tampa" when only the city is known, or just "their property"'),
    YOUR_PROPERTY,
    text('local_time', 'the person\'s local day and time when the call starts, e.g. "Tuesday 4:12 PM"'),
    text('crm_notes', 'the person\'s Salesforce notes and recent activity, cleaned up and cut to the newest 3,000 characters ("(no notes on file)" when there are none)'),
    CALLBACK_NUMBER,
    text('callback_number_spoken', 'the callback number in words, e.g. "five one two, five five five, zero one zero zero" (empty when there is none)'),
    section('call_plan', 'the call plan your team approved for this call: {{#call_plan}}…{{/call_plan}} shows a block only when there is one, and {{call_plan}} inside it is the plan itself'),
    section('is_test', 'on for a test call placed from the app: {{#is_test}}…{{/is_test}} shows a block only then, {{^is_test}}…{{/is_test}} only on real calls'),
    section('returning', 'on when we have spoken with this person before and the call plan says so: {{#returning}}…{{/returning}} shows a block only then'),
    section('can_book', 'on when this call has appointment times the agent may book: {{#can_book}}…{{/can_book}} shows a block only then'),
    section('offers_phone_call', 'on when the appointment times include phone calls'),
    section('offers_walkthrough', 'on when the appointment times include in-person walkthroughs (only offered when the address has a street)'),
    text('specialist_name', 'the first name of the specialist the appointment times are with, e.g. "Grant" (empty when unknown)'),
    section('appointment_times', 'the times the agent may book: {{#appointment_times}}…{{/appointment_times}} repeats its block once for each time'),
    text('time_id', 'inside appointment_times: the code the agent books the time by, e.g. "p1"'),
    text('time_kind', 'inside appointment_times: "phone call" or "walkthrough"'),
    text('time_text', 'inside appointment_times: the day and time in the person\'s time zone, e.g. "Wednesday, October 7 at 2 PM their time, 11 AM Pacific"'),
  ],
  voicemail: [FIRST_NAME, AGENT_NAME, COMPANY_NAME, YOUR_PROPERTY, CALLBACK_NUMBER],
};

const OWNER = '0058X00000Fsx39QAB';

/** The preview's sample call: Jane at 1234 Oak St in Tampa, spoken with before, with a plan, two times with Grant and a callback number. */
export const SAMPLE_INPUT: PromptInput = {
  agentName: 'Alex',
  companyName: 'GG Homes',
  firstName: 'Jane',
  address: '1234 Oak St, Tampa, FL 33601',
  notes: 'Notes: Inherited the house from her mother; roof leaks.\nTask 2026-09-01 — Call: said maybe in spring',
  isTest: false,
  localTime: 'Tuesday 4:12 PM',
  callbackNumber: '+15125550100',
  approvedPlan: 'Opener: Remind them we last spoke in the spring about the roof.\n\nQuestions:\n- Is the roof still leaking?',
  returning: true,
  slots: [
    {
      id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
      specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
    },
    {
      id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z',
      specialistSfUserId: OWNER, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
    },
  ],
  sellerTimeZone: 'America/New_York',
};

const NUMBER = new Intl.NumberFormat('en-US');
const NAMED_TAGS = new Set(['name', '&', '#', '^']);
const NO_ESCAPE = { escape: (value: string) => value };

/** A Mustache token: [type, value, start, end, sub-tokens (sections), ...]. */
type Token = readonly [string, string, number, number, ...unknown[]];

const lineAt = (template: string, index: number): number => template.slice(0, index).split('\n').length;

/** Mustache's parse error in plain words, with its line (from the character position the message ends with). */
function parseProblem(template: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const at = / at (\d+)$/.exec(message);
  const raw = at ? message.slice(0, at.index) : message;
  const unclosed = /^Unclosed section "(.*)"$/.exec(raw);
  const unopened = /^Unopened section "(.*)"$/.exec(raw);
  const what = unclosed
    ? `Section "${unclosed[1]}" is never closed — add {{/${unclosed[1]}}}`
    : unopened
      ? `{{/${unopened[1]}}} closes a section that was never opened`
      : raw === 'Unclosed tag'
        ? 'A tag is missing its closing }}'
        : `The prompt can't be read: ${raw}`;
  return at ? `${what} (line ${lineAt(template, Number(at[1]))})` : what;
}

/** Every tag naming something the kind does not have, in template order; a partial is never known. */
function unknownNames(tokens: readonly Token[], known: ReadonlySet<string>): string[] {
  return tokens.flatMap((t) => {
    const [type, name] = t;
    const own = type === '>' ? [`> ${name}`] : NAMED_TAGS.has(type) && !known.has(name) ? [name] : [];
    const inner = Array.isArray(t[4]) ? unknownNames(t[4] as Token[], known) : [];
    return [...own, ...inner];
  });
}

/** Why `template` can't be used for `kind` (empty when it can): size, then syntax or unknown placeholders. */
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
  return [...size, ...[...new Set(unknownNames(tokens, known))].map((name) => `Unknown placeholder: ${name}`)];
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

/**
 * The check behind save and preview: the kind's default and placeholders, the plain-words problems with
 * `template` (null = the default), and — only when there are none — the template rendered over SAMPLE_INPUT.
 */
export function checkTemplate(kind: AgentPromptKind, template: string | null): AgentPromptCheck {
  const defaultTemplate = DEFAULT_TEMPLATES[kind];
  const body = template ?? defaultTemplate;
  const writer = new Mustache.Writer();
  const problems = templateProblems(kind, body, writer);
  return {
    defaultTemplate,
    placeholders: PLACEHOLDERS[kind].map((p) => ({ ...p })),
    rendered: problems.length > 0 ? null : writer.render(body, promptView(SAMPLE_INPUT), undefined, NO_ESCAPE),
    problems,
  };
}
