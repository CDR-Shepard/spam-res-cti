/**
 * The agent's instructions and voicemail as Mustache templates (plan 2026-10-16 editable agent prompts, Task 3).
 *
 * __fixtures__/prompt-golden.json was captured from the string-building prompt code BEFORE it became templates
 * (instructions pinned by sha256, voicemail by full text): the built-in default templates must reproduce every entry
 * byte for byte, so deploying templates changes nothing until someone saves a version.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Mustache from 'mustache';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROMPT_MAX_CHARS, AgentPromptCheck, AppointmentSlots, Consultations, PriorityOffer, type AgentPromptKind } from '@cti/contracts';
import { DEFAULT_INBOUND_TEMPLATE } from './prompt-default-inbound.js';
import { DEFAULT_INSTRUCTIONS_TEMPLATE } from './prompt-default-instructions.js';
import { DEFAULT_VOICEMAIL_TEMPLATE } from './prompt-default-voicemail.js';
import { neutraliseFences } from './prompt-plan.js';
import { PLACEHOLDERS, SAMPLE_INPUT, checkTemplate, renderPrompt } from './prompt-template.js';
import { promptView } from './prompt-view.js';
import { buildInboundInstructions, buildInstructions, voicemailText, type PromptInput, type TemplateErrorHandler } from './prompt.js';

interface GoldenEntry {
  name: string;
  input: PromptInput;
  instructionsSha256: string;
  voicemail: string;
}

const GOLDEN = JSON.parse(readFileSync(new URL('./__fixtures__/prompt-golden.json', import.meta.url), 'utf8')) as GoldenEntry[];
const ALL_NULL = GOLDEN.find((e) => e.name.startsWith('extreme all-null'))!.input;
const DEFAULTS: Readonly<Record<AgentPromptKind, string>> = {
  instructions: DEFAULT_INSTRUCTIONS_TEMPLATE,
  voicemail: DEFAULT_VOICEMAIL_TEMPLATE,
  inbound: DEFAULT_INBOUND_TEMPLATE,
};
/** Every kind: the general checks below run for each (the inbound kind too; final review M-8). */
const KINDS: readonly AgentPromptKind[] = ['instructions', 'voicemail', 'inbound'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const JANE: PromptInput = {
  agentName: 'Ava',
  companyName: 'GG Homes',
  firstName: 'Jane',
  address: '1234 Oak St, Tampa, FL 33601',
  notes: 'Roof leaks.',
  isTest: false,
  localTime: 'Tuesday 4:12 PM',
  callbackNumber: '+15125550100',
};
const PLAN = 'Opener: Ask whether the roof was fixed.';

/** Every placeholder name a template uses, walking into sections (the test's own walk of Mustache's tokens). */
function namesIn(template: string): Set<string> {
  const names = new Set<string>();
  const walk = (tokens: unknown[][]) => {
    for (const t of tokens) {
      if (['name', '&', '#', '^'].includes(t[0] as string)) names.add(t[1] as string);
      if (Array.isArray(t[4])) walk(t[4] as unknown[][]);
    }
  };
  walk(Mustache.parse(template) as unknown[][]);
  return names;
}

/** A custom template using every placeholder of the kind: text ones as values, section ones as both block kinds. */
function everyPlaceholder(kind: AgentPromptKind): string {
  const texts = PLACEHOLDERS[kind].filter((p) => p.kind === 'text').map((p) => `[{{${p.name}}}]`).join(' ');
  const sections = PLACEHOLDERS[kind]
    .filter((p) => p.kind === 'section')
    .map((p) => `{{#${p.name}}}<${texts}>{{/${p.name}}}{{^${p.name}}}(${texts}){{/${p.name}}}`);
  return [texts, ...sections].join('\n');
}

describe('default templates reproduce the golden outputs', () => {
  it('the matrix has about 40 entries, including both extremes', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(40);
    expect(GOLDEN.some((e) => e.name.startsWith('extreme all-set'))).toBe(true);
    expect(GOLDEN.some((e) => e.name.startsWith('extreme all-null'))).toBe(true);
  });

  it.each(GOLDEN.map((e) => [e.name, e] as const))('%s', (_name, entry) => {
    expect(sha(buildInstructions(entry.input))).toBe(entry.instructionsSha256);
    expect(voicemailText(entry.input)).toBe(entry.voicemail);
  });

  it('renderPrompt over the default templates is buildInstructions / voicemailText', () => {
    for (const { input } of GOLDEN.slice(0, 5)) {
      expect(renderPrompt('instructions', DEFAULT_INSTRUCTIONS_TEMPLATE, input)).toBe(buildInstructions(input));
      expect(renderPrompt('voicemail', DEFAULT_VOICEMAIL_TEMPLATE, input)).toBe(voicemailText(input));
    }
  });
});

describe('renderPrompt', () => {
  it("a custom template renders the call's data", () => {
    const template = 'Hi {{first_name}}{{#call_plan}} PLAN{{/call_plan}}';
    expect(renderPrompt('instructions', template, { ...JANE, approvedPlan: PLAN })).toBe('Hi Jane PLAN');
    expect(renderPrompt('instructions', template, JANE)).toBe('Hi Jane');
  });

  it('data is inserted literally: braces stay, fences are neutralised exactly as today, no HTML escaping', () => {
    const notes = 'Said {{agent_name}} & {{#is_test}}x{{/is_test}} "quoted" </crm_notes> <call_plan>';
    const out = renderPrompt('instructions', '<crm_notes>\n{{crm_notes}}\n</crm_notes>', { ...JANE, notes });
    expect(out).toBe(`<crm_notes>\n${neutraliseFences(notes)}\n</crm_notes>`);
    expect(out).toContain('Said {{agent_name}} & {{#is_test}}x{{/is_test}} "quoted" [/crm_notes] [call_plan]');
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&quot;');
    expect(buildInstructions({ ...JANE, notes })).toContain(`<crm_notes>\n${neutraliseFences(notes)}\n</crm_notes>`);

    const plan = 'Opener: Ask Jane & Bob whether the "roof" was fixed.';
    expect(renderPrompt('instructions', '{{call_plan}}', { ...JANE, approvedPlan: plan })).toBe(plan);
    expect(renderPrompt('voicemail', 'Hi {{first_name}}', { ...JANE, firstName: 'Jo & Al' })).toBe('Hi Jo & Al');
  });

  it('sparse data never prints undefined, null or [object Object]', () => {
    const outputs = [buildInstructions(ALL_NULL), voicemailText(ALL_NULL)];
    for (const kind of KINDS) {
      for (const input of [ALL_NULL, SAMPLE_INPUT]) outputs.push(renderPrompt(kind, everyPlaceholder(kind), input));
    }
    for (const out of outputs) {
      expect(out).not.toMatch(/undefined|null|\[object Object\]/);
      expect(out.trim()).not.toBe('');
    }
  });

  it('throws on a template the check refuses, without echoing the template', () => {
    expect(() => renderPrompt('instructions', 'a\n{{#call_plan}}x', JANE)).toThrow();
    expect(() => renderPrompt('instructions', '{{secret_word}}', JANE)).toThrow();
    expect(() => renderPrompt('voicemail', '   ', JANE)).toThrow();
    try {
      renderPrompt('instructions', '{{secret_word}}', JANE);
    } catch (e) {
      expect(String(e)).not.toContain('secret_word');
    }
  });

  it('never changes the global Mustache.escape', () => {
    renderPrompt('instructions', '{{crm_notes}}', { ...JANE, notes: '<b>&</b>' });
    expect(Mustache.escape('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('inherited object names are not placeholders, so nothing but view data can be looked up', () => {
    const check = checkTemplate('instructions', '{{constructor}} {{toString}} {{#hasOwnProperty}}x{{/hasOwnProperty}} {{.}}');
    expect(check.problems).toEqual([
      'Unknown placeholder: constructor',
      'Unknown placeholder: toString',
      'Unknown placeholder: hasOwnProperty',
      'Unknown placeholder: .',
    ]);
    expect(check.rendered).toBeNull();
  });
});

describe('promptView', () => {
  it('holds only strings, booleans and lists of string records (never functions)', () => {
    for (const input of [ALL_NULL, SAMPLE_INPUT]) {
      for (const value of Object.values(promptView(input))) {
        if (Array.isArray(value)) {
          for (const item of value) for (const v of Object.values(item as object)) expect(typeof v).toBe('string');
        } else {
          expect(['string', 'boolean']).toContain(typeof value);
        }
      }
    }
  });

  it('carries every listed placeholder that is not a list field', () => {
    const view = promptView(SAMPLE_INPUT);
    const listFields = new Set(['time_id', 'time_kind', 'time_with', 'time_text']);
    for (const p of PLACEHOLDERS.instructions.filter((x) => !listFields.has(x.name))) expect(view).toHaveProperty(p.name);
    const times = view.appointment_times as ReadonlyArray<Record<string, string>>;
    expect(times.map((t) => Object.keys(t).sort())).toEqual([[...listFields].sort(), [...listFields].sort()]);
  });
});

describe('checkTemplate', () => {
  it('names an unknown placeholder', () => {
    expect(checkTemplate('instructions', '{{frist_name}}').problems).toContain('Unknown placeholder: frist_name');
  });

  it('finds unknown placeholders inside sections, each once', () => {
    expect(checkTemplate('instructions', '{{#call_plan}}{{nope}}{{/call_plan}} {{nope}} {{^returning}}{{&raw}}{{/returning}}').problems).toEqual([
      'Unknown placeholder: nope',
      'Unknown placeholder: raw',
    ]);
  });

  it('reports a parse error once, with its line', () => {
    const problems = checkTemplate('instructions', 'a\n{{#call_plan}}x').problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('line 2');
    const unopened = checkTemplate('instructions', 'one\ntwo\n{{/call_plan}}').problems;
    expect(unopened).toHaveLength(1);
    expect(unopened[0]).toContain('line 3');
    expect(checkTemplate('instructions', 'one\n{{first_name').problems).toEqual(['A tag is missing its closing }} (line 2)']);
    // Mustache gives no position for bad delimiters: the problem is still reported, without a line.
    expect(checkTemplate('instructions', '{{=x=}}').problems).toEqual(["The prompt can't be read: Invalid tags: x"]);
  });

  it('refuses an empty prompt', () => {
    expect(checkTemplate('instructions', '   ').problems).toEqual(['Prompt is empty']);
    expect(checkTemplate('voicemail', '\n\t').problems).toEqual(['Prompt is empty']);
  });

  it('refuses a prompt over the limit for its kind', () => {
    expect(checkTemplate('instructions', 'x'.repeat(60_001)).problems).toEqual(['Prompt is longer than 60,000 characters']);
    expect(checkTemplate('instructions', 'x'.repeat(60_000)).problems).toEqual([]);
    expect(checkTemplate('voicemail', 'x'.repeat(1_501)).problems).toEqual(['Prompt is longer than 1,500 characters']);
    expect(checkTemplate('voicemail', 'x'.repeat(1_500)).problems).toEqual([]);
  });

  it('treats a partial as an unknown placeholder', () => {
    const check = checkTemplate('instructions', '{{> partial}}');
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatch(/^Unknown placeholder: /);
    expect(checkTemplate('instructions', '{{> first_name}}').problems).toHaveLength(1);
  });

  it('only knows the voicemail placeholders in a voicemail', () => {
    expect(checkTemplate('voicemail', '{{crm_notes}}').problems).toEqual(['Unknown placeholder: crm_notes']);
  });

  it('null checks the default: no problems, the default template, the placeholders, and the sample render', () => {
    for (const kind of KINDS) {
      const check = checkTemplate(kind, null);
      expect(AgentPromptCheck.parse(check)).toEqual(check);
      expect(check.problems).toEqual([]);
      expect(check.defaultTemplate).toBe(DEFAULTS[kind]);
      expect(check.placeholders).toEqual(PLACEHOLDERS[kind]);
    }
    expect(checkTemplate('instructions', null).rendered).toBe(buildInstructions(SAMPLE_INPUT));
    expect(checkTemplate('voicemail', null).rendered).toBe(voicemailText(SAMPLE_INPUT));
  });

  it('a good custom template is rendered over the sample call; a refused one is not rendered', () => {
    const good = checkTemplate('voicemail', 'Hi {{first_name}}, call {{callback_number}}. {{! a note to self }}');
    expect(good).toMatchObject({ problems: [], rendered: 'Hi Jane, call 512-555-0100. ' });
    expect(checkTemplate('voicemail', 'Hi {{frist_name}}').rendered).toBeNull();
  });
});

describe('checkTemplate — fix round 1', () => {
  it('points an unclosed section or tag at the line it opens on, not the end of the prompt', () => {
    expect(checkTemplate('instructions', 'a\n{{#call_plan}}x\nb\nc\nd\ne').problems).toEqual([
      'Section "call_plan" is never closed — add {{/call_plan}} (line 2)',
    ]);
    expect(checkTemplate('instructions', 'a\n{{^ returning }}x\nb\nc').problems).toEqual([
      'Section "returning" is never closed — add {{/returning}} (line 2)',
    ]);
    // The inner section closes; the outer one, on line 1, never does.
    expect(checkTemplate('instructions', '{{#returning}}\n{{#returning}}\n{{/returning}}\nz').problems).toEqual([
      'Section "returning" is never closed — add {{/returning}} (line 1)',
    ]);
    expect(checkTemplate('instructions', '{{#is_test}}\n{{#returning}}\nx\n{{/returning}}\ny\nz').problems).toEqual([
      'Section "is_test" is never closed — add {{/is_test}} (line 1)',
    ]);
    expect(checkTemplate('instructions', 'a\n{{first_name\nb\nc').problems).toEqual(['A tag is missing its closing }} (line 2)']);
    expect(checkTemplate('instructions', '{{first_name}}\nb {{street\nc\nd').problems).toEqual(['A tag is missing its closing }} (line 2)']);
  });

  it('refuses a yes/no or list placeholder used as a value, in every value form', () => {
    const message = 'appointment_times is a section — use {{#appointment_times}}…{{/appointment_times}}';
    for (const t of ['x {{appointment_times}}', 'x {{{appointment_times}}}', 'x {{& appointment_times}}']) {
      expect(checkTemplate('instructions', t)).toMatchObject({ problems: [message], rendered: null });
    }
    expect(checkTemplate('instructions', '{{can_book}}').problems).toEqual(['can_book is a section — use {{#can_book}}…{{/can_book}}']);
    expect(checkTemplate('instructions', '{{#call_plan}}{{call_plan}}{{/call_plan}}').problems).toEqual([]);
    expect(() => renderPrompt('instructions', '{{can_book}}', SAMPLE_INPUT)).toThrow();
  });

  it('flags exactly the placeholders whose value is yes/no or a list', () => {
    const view = promptView(SAMPLE_INPUT);
    for (const p of PLACEHOLDERS.instructions) {
      const value = view[p.name];
      const blockOnly = typeof value === 'boolean' || Array.isArray(value);
      const problems = checkTemplate('instructions', `{{${p.name}}}`).problems;
      // Used as a value, the fields of an appointment time (time_id, time_kind, time_with, time_text) are empty outside
      // {{#appointment_times}}, so a prompt made of only one of them is now refused for coming out empty (final review C1).
      // So is a text value the sample call leaves empty (booked_consultation_text: the sample has no booked consultation).
      const emptyAtTop = (value === undefined || value === '') && !blockOnly;
      expect(problems.some((m) => m.endsWith('is a section — use ' + `{{#${p.name}}}…{{/${p.name}}}`)), p.name).toBe(blockOnly);
      expect(problems.includes('The prompt comes out empty for the sample call'), p.name).toBe(emptyAtTop);
      expect(problems.length > 0, p.name).toBe(blockOnly || emptyAtTop);
    }
  });

  it('never throws for any placeholder used as a value, at the top or inside any section', () => {
    for (const kind of KINDS) {
      const sections = PLACEHOLDERS[kind].filter((p) => p.kind === 'section').map((p) => p.name);
      for (const p of PLACEHOLDERS[kind]) {
        const values = [`{{${p.name}}}`, `{{{${p.name}}}}`, `{{& ${p.name}}}`];
        for (const t of values.flatMap((v) => [v, ...sections.map((s) => `{{#${s}}}${v}{{/${s}}}`)])) {
          const check = checkTemplate(kind, t);
          if (check.rendered !== null) expect(check.rendered, t).not.toMatch(/undefined|null|\[object Object\]/);
        }
      }
    }
  });

  it('a sample render that throws becomes a problem, never an exception', () => {
    const spy = vi.spyOn(Mustache.Writer.prototype, 'render').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(checkTemplate('voicemail', 'Hi {{first_name}}')).toMatchObject({
        rendered: null,
        problems: ["The prompt couldn't be rendered for the sample call"],
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SAMPLE_INPUT (the preview call)', () => {
  it('is Jane at 1234 Oak St in Tampa, returning, with a plan, met by Blake in March, times with Seth and Blake, Grant for high priority, and a callback number, not a test call', () => {
    expect(SAMPLE_INPUT).toMatchObject({ firstName: 'Jane', isTest: false, returning: true });
    expect(SAMPLE_INPUT.address).toContain('1234 Oak St');
    expect(SAMPLE_INPUT.address).toContain('Tampa');
    expect(SAMPLE_INPUT.callbackNumber).toMatch(/^\+1\d{10}$/);
    expect(AppointmentSlots.parse(SAMPLE_INPUT.slots).map((s) => [s.id, s.specialistFirstName, s.region])).toEqual([
      ['p1', 'Seth', 'SD'],
      ['w1', 'Blake', 'LA'],
    ]);
    expect(Consultations.parse(SAMPLE_INPUT.consultations)).toEqual({
      last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' },
      next: null,
    });
    expect(PriorityOffer.parse(SAMPLE_INPUT.priority).specialistFirstName).toBe('Grant');
    const text = buildInstructions(SAMPLE_INPUT);
    expect(text).toContain('<call_plan>');
    expect(text).toContain("we've spoken before");
    expect(text).toContain("- We've met with them before: an in-person consultation on March 12 with Blake.");
    expect(text).toContain('# Booking an appointment');
    expect(text).toContain('- p1: phone consultation with Seth, ');
    expect(text).toContain('- w1: in-person consultation with Blake, ');
    expect(text).toContain('# High priority');
    expect(text).toContain('offer an in-person consultation with Grant at the time they ask for');
    expect(text).not.toContain('this is a test call');
  });
});

describe('routing step 1 placeholders (Task 11)', () => {
  it('a template using every new placeholder is accepted, and renders the sample call', () => {
    const template = [
      '{{#can_book_any}}Can book.{{/can_book_any}}',
      '{{#had_consultation}}Met {{#last_consultation_in_person}}in person{{/last_consultation_in_person}}{{^last_consultation_in_person}}by phone{{/last_consultation_in_person}} on {{last_consultation_when}}{{#last_consultation_with}} with {{last_consultation_with}}{{/last_consultation_with}}.{{/had_consultation}}',
      '{{#has_booked_consultation}}Booked: {{booked_consultation_text}}.{{/has_booked_consultation}}',
      '{{#appointment_times}}- {{time_id}}: {{time_kind}}{{#time_with}} with {{time_with}}{{/time_with}}, {{time_text}}',
      '{{/appointment_times}}',
      '{{#can_book_priority}}High priority with {{priority_specialist_name}}, else {{priority_default_text}}.{{/can_book_priority}}',
    ].join('\n');
    const check = checkTemplate('instructions', template);
    expect(check.problems).toEqual([]);
    expect(check.rendered).toBe(
      [
        'Can book.',
        'Met in person on March 12 with Blake.',
        '',
        '- p1: phone consultation with Seth, Wednesday, October 7 at 2 PM their time, 11 AM Pacific',
        '- w1: in-person consultation with Blake, Thursday, October 8 at 12 PM their time, 9 AM Pacific',
        'High priority with Grant, else Wednesday, October 7 at 12 PM their time, 9 AM Pacific.',
      ].join('\n'),
    );
  });

  it.each(['can_book_priority', 'can_book_any', 'had_consultation', 'last_consultation_in_person', 'has_booked_consultation'])(
    'refuses %s used as a value: it is a section (BLOCK_ONLY)',
    (name) => {
      expect(checkTemplate('instructions', `Hi {{${name}}}`)).toMatchObject({ problems: [`${name} is a section — use {{#${name}}}…{{/${name}}}`], rendered: null });
      expect(() => renderPrompt('instructions', `{{${name}}}`, SAMPLE_INPUT)).toThrow(/refused/);
    },
  );
});

describe('buildInstructions / voicemailText with saved templates', () => {
  it('render the saved template when it is set', () => {
    expect(buildInstructions({ ...JANE, templates: { instructions: 'Hi {{first_name}}', voicemail: null } })).toBe('Hi Jane');
    expect(voicemailText({ ...JANE, templates: { instructions: null, voicemail: 'Call {{callback_number}}' } })).toBe('Call 512-555-0100');
  });

  it('use the default when the saved template is null', () => {
    const templates = { instructions: null, voicemail: null };
    expect(buildInstructions({ ...JANE, templates })).toBe(buildInstructions(JANE));
    expect(voicemailText({ ...JANE, templates })).toBe(voicemailText(JANE));
  });

  it('fall back to the default when the saved template fails', () => {
    for (const bad of ['a\n{{#call_plan}}x', '{{frist_name}}', '   ']) {
      const templates = { instructions: bad, voicemail: bad };
      expect(buildInstructions({ ...JANE, templates })).toBe(buildInstructions(JANE));
      expect(voicemailText({ ...JANE, templates })).toBe(voicemailText(JANE));
    }
  });
});

describe('buildInstructions / voicemailText: onTemplateError', () => {
  it('is told the kind when a saved template fails, and the default is still used', () => {
    const calls: string[] = [];
    const templates = { instructions: '{{frist_name}}', voicemail: '{{#call_plan}}never closed' };
    expect(buildInstructions({ ...JANE, templates }, (kind) => calls.push(kind))).toBe(buildInstructions(JANE));
    expect(voicemailText({ ...JANE, templates }, (kind) => calls.push(kind))).toBe(voicemailText(JANE));
    expect(calls).toEqual(['instructions', 'voicemail']);
  });

  it('is not called for a template that renders, a null template, or no templates at all', () => {
    const onError = vi.fn();
    buildInstructions({ ...JANE, templates: { instructions: 'Hi {{first_name}}', voicemail: null } }, onError);
    buildInstructions({ ...JANE, templates: { instructions: null, voicemail: null } }, onError);
    voicemailText(JANE, onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a callback that throws never breaks the prompt', () => {
    const boom = () => {
      throw new Error('logger down');
    };
    expect(buildInstructions({ ...JANE, templates: { instructions: '{{nope}}', voicemail: null } }, boom)).toBe(buildInstructions(JANE));
  });
});

/** `name` opened inside itself `depth` times around "x". */
const nested = (depth: number, name = 'appointment_times'): string => `{{#${name}}}`.repeat(depth) + 'x' + `{{/${name}}}`.repeat(depth);

describe('a template that renders empty (final review C1)', () => {
  const EMPTY_WORDS = 'The prompt comes out empty for the sample call';

  it('the check refuses a template whose sample render is empty or only whitespace', () => {
    for (const t of ['{{^appointment_times}}none{{/appointment_times}}', '{{^call_plan}}x{{/call_plan}}\n', '{{! only a note }}', '{{time_id}}']) {
      expect(checkTemplate('instructions', t), t).toMatchObject({ problems: [EMPTY_WORDS], rendered: null });
    }
    expect(checkTemplate('voicemail', '{{^callback_number}}Call us.{{/callback_number}}')).toMatchObject({ problems: [EMPTY_WORDS], rendered: null });
  });

  it('a template that shows something for the sample call is still accepted', () => {
    expect(checkTemplate('instructions', '{{#call_plan}}{{call_plan}}{{/call_plan}}').problems).toEqual([]);
    expect(checkTemplate('voicemail', '{{#callback_number}}Call {{callback_number}}.{{/callback_number}}').problems).toEqual([]);
  });

  it('a call whose data hides every block of the instructions uses the default, and the hook is told', () => {
    const onError = vi.fn();
    const templates = { instructions: '{{#call_plan}}Follow {{call_plan}}{{/call_plan}}', voicemail: null };
    expect(buildInstructions({ ...JANE, templates }, onError)).toBe(buildInstructions(JANE));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('instructions', 'empty_render');
    // The same template is fine on a call that has a plan, and then nothing is reported.
    onError.mockClear();
    expect(buildInstructions({ ...JANE, approvedPlan: PLAN, templates }, onError)).toBe(`Follow ${PLAN}`);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a voicemail that renders to nothing (no callback number) is the default voicemail, never a silent <Say>', () => {
    const onError = vi.fn();
    const noCallback = { ...JANE, callbackNumber: null, templates: { instructions: null, voicemail: '{{#callback_number}}Call {{callback_number}}{{/callback_number}}' } };
    expect(voicemailText(noCallback, onError)).toBe(voicemailText({ ...JANE, callbackNumber: null }));
    expect(voicemailText(noCallback, onError).trim()).not.toBe('');
    expect(onError).toHaveBeenCalledWith('voicemail', 'empty_render');
  });

  it('whitespace-only output counts as empty', () => {
    const onError = vi.fn();
    const templates = { instructions: ' {{#call_plan}}x{{/call_plan}}\n\t', voicemail: null };
    expect(buildInstructions({ ...JANE, templates }, onError)).toBe(buildInstructions(JANE));
    expect(onError).toHaveBeenCalledWith('instructions', 'empty_render');
  });

  it('a throwing hook never breaks the fallback to the default', () => {
    const boom = () => {
      throw new Error('logger down');
    };
    const templates = { instructions: null, voicemail: '{{#callback_number}}x{{/callback_number}}' };
    expect(voicemailText({ ...JANE, callbackNumber: null, templates }, boom)).toBe(voicemailText({ ...JANE, callbackNumber: null }));
  });

  it('a render of a render error still reports render_error', () => {
    const onError = vi.fn();
    buildInstructions({ ...JANE, templates: { instructions: '{{nope}}', voicemail: null } }, onError);
    expect(onError).toHaveBeenCalledWith('instructions', 'render_error');
  });
});

describe('a template that grows without bound (final review C2)', () => {
  it('refuses a list section opened inside itself, in every block form, however far apart', () => {
    const message = "appointment_times can't be nested inside itself";
    for (const t of [
      nested(2),
      '{{#appointment_times}}{{^appointment_times}}x{{/appointment_times}}{{/appointment_times}}',
      '{{^appointment_times}}{{#appointment_times}}x{{/appointment_times}}{{/appointment_times}}',
      '{{#appointment_times}}{{#can_book}}{{#appointment_times}}{{time_id}}{{/appointment_times}}{{/can_book}}{{/appointment_times}}',
    ]) {
      expect(checkTemplate('instructions', t), t).toMatchObject({ problems: [message], rendered: null });
    }
  });

  it('a list section used twice side by side, or inside other sections, is fine', () => {
    expect(checkTemplate('instructions', '{{#appointment_times}}{{time_id}} {{/appointment_times}}{{#appointment_times}}{{time_text}}{{/appointment_times}}').problems).toEqual([]);
    expect(checkTemplate('instructions', '{{#can_book}}{{#returning}}{{#appointment_times}}{{time_id}}{{/appointment_times}}{{/returning}}{{/can_book}}').problems).toEqual([]);
    // A yes/no section may repeat itself: it never multiplies the text.
    expect(checkTemplate('instructions', nested(2, 'returning')).problems).toEqual([]);
  });

  it('refuses sections nested more than 8 levels deep, and accepts exactly 8', () => {
    expect(checkTemplate('instructions', nested(8, 'returning')).problems).toEqual([]);
    expect(checkTemplate('instructions', nested(9, 'returning'))).toMatchObject({
      problems: ['Sections are nested too deeply (more than 8 levels)'],
      rendered: null,
    });
  });

  it('a very deep template is refused without recursing to a stack overflow', () => {
    const check = checkTemplate('instructions', nested(2_400, 'is_test'));
    expect(check.rendered).toBeNull();
    expect(check.problems).toEqual(['Sections are nested too deeply (more than 8 levels)']);
    expect(() => renderPrompt('instructions', nested(2_400, 'is_test'), JANE)).toThrow(/refused/);
  });

  it('a depth-30 self-nested list is refused quickly, and nothing is rendered', () => {
    const spy = vi.spyOn(Mustache.Writer.prototype, 'render');
    try {
      const template = nested(30);
      const started = performance.now();
      const check = checkTemplate('instructions', template);
      expect(() => renderPrompt('instructions', template, SAMPLE_INPUT)).toThrow(/refused/);
      expect(performance.now() - started).toBeLessThan(250);
      expect(check.rendered).toBeNull();
      expect(check.problems).toEqual(
        expect.arrayContaining(["appointment_times can't be nested inside itself", 'Sections are nested too deeply (more than 8 levels)']),
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a call whose saved template nests a list inside itself uses the default, renders only the default, and the hook is told', () => {
    const spy = vi.spyOn(Mustache.Writer.prototype, 'render');
    try {
      const onError = vi.fn();
      const started = performance.now();
      const out = buildInstructions({ ...JANE, slots: SAMPLE_INPUT.slots, templates: { instructions: nested(30), voicemail: null } }, onError);
      expect(performance.now() - started).toBeLessThan(250);
      expect(out).toBe(buildInstructions({ ...JANE, slots: SAMPLE_INPUT.slots }));
      expect(onError).toHaveBeenCalledWith('instructions', 'render_error');
      expect(spy).toHaveBeenCalledTimes(2); // the default render above, and the default render after the refusal
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a sample render longer than twice the kind\'s limit', () => {
    // 4,600 x {{crm_notes}} (13 chars = 59,800, inside the size limit) renders far past 120,000 characters over the sample notes.
    const check = checkTemplate('instructions', '{{crm_notes}}'.repeat(4_600));
    expect(check.rendered).toBeNull();
    expect(check.problems).toEqual(['The prompt comes out too long for the sample call (over 120,000 characters)']);
  });

  it('a call whose saved template renders past twice the limit uses the default, and the hook is told', () => {
    const onError = vi.fn();
    const notes = 'n'.repeat(3_000);
    const templates = { instructions: '{{crm_notes}}'.repeat(60), voicemail: null }; // passes the size limit; 60 x 3,000 = 180,000 for this call
    expect(buildInstructions({ ...JANE, notes, templates }, onError)).toBe(buildInstructions({ ...JANE, notes }));
    expect(onError).toHaveBeenCalledWith('instructions', 'too_long');
  });
});

describe('PLACEHOLDERS', () => {
  it.each(KINDS)('%s: every placeholder the default uses is listed', (kind) => {
    const listed = new Set(PLACEHOLDERS[kind].map((p) => p.name));
    expect([...namesIn(DEFAULTS[kind])].filter((n) => !listed.has(n))).toEqual([]);
  });

  // The inbound default is the owner's prompt verbatim and uses none of its placeholders; they are offered for edits.
  // specialist_name: since routing step 1 each time names its own specialist (time_with), so the default no longer uses it,
  // but a saved template may: it stays offered, or that template would be refused and the call would fall back.
  const KEPT_FOR_SAVED: ReadonlySet<string> = new Set(['specialist_name']);
  it.each(['instructions', 'voicemail'] as const)('%s: every listed placeholder is used by the default', (kind) => {
    const used = namesIn(DEFAULTS[kind]);
    expect(PLACEHOLDERS[kind].map((p) => p.name).filter((n) => !used.has(n) && !KEPT_FOR_SAVED.has(n))).toEqual([]);
  });

  it.each(KINDS)('%s: snake_case names, each once, with a one-line description', (kind) => {
    const names = PLACEHOLDERS[kind].map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PLACEHOLDERS[kind]) {
      expect(p.name).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
      expect(['text', 'section']).toContain(p.kind);
      expect(p.description.trim().length).toBeGreaterThan(10);
      expect(p.description).not.toMatch(/\n/);
    }
  });
});

/** The same safety checks for every kind (final review M-8): each with a text placeholder it offers, and how a call builds it. */
const SAFETY: Readonly<Record<AgentPromptKind, { value: string; build: (p: PromptInput, onError?: TemplateErrorHandler) => string }>> = {
  instructions: { value: 'first_name', build: buildInstructions },
  voicemail: { value: 'first_name', build: voicemailText },
  inbound: { value: 'caller_number', build: buildInboundInstructions },
};
const CALL: PromptInput = { ...JANE, callerNumber: '+16195550142' };
const saved = (kind: AgentPromptKind, template: string, over: Partial<PromptInput> = {}): PromptInput => ({
  ...CALL,
  ...over,
  templates: { instructions: null, voicemail: null, inbound: null, [kind]: template },
});

describe.each(KINDS)('%s: the general template-safety checks (final review M-8)', (kind) => {
  const { value, build } = SAFETY[kind];
  const max = AGENT_PROMPT_MAX_CHARS[kind];

  it('refuses an empty prompt, and one whose sample render is empty', () => {
    expect(checkTemplate(kind, '  \n\t').problems).toEqual(['Prompt is empty']);
    for (const t of ['{{! only a note }}', `{{^${value}}}shown only without it{{/${value}}}\n`]) {
      expect(checkTemplate(kind, t), t).toMatchObject({ problems: ['The prompt comes out empty for the sample call'], rendered: null });
    }
  });

  it("refuses a prompt over the kind's size limit, and accepts exactly the limit", () => {
    expect(checkTemplate(kind, 'x'.repeat(max + 1)).problems).toEqual([`Prompt is longer than ${max.toLocaleString('en-US')} characters`]);
    expect(checkTemplate(kind, 'x'.repeat(max)).problems).toEqual([]);
  });

  it('refuses an unknown placeholder, a partial, and an inherited object name', () => {
    expect(checkTemplate(kind, 'Hi {{frist_name}}')).toMatchObject({ problems: ['Unknown placeholder: frist_name'], rendered: null });
    expect(checkTemplate(kind, '{{> partial}}').problems).toEqual([expect.stringMatching(/^Unknown placeholder: /)]);
    expect(checkTemplate(kind, '{{constructor}} {{#hasOwnProperty}}x{{/hasOwnProperty}}').problems).toEqual([
      'Unknown placeholder: constructor',
      'Unknown placeholder: hasOwnProperty',
    ]);
  });

  it('refuses sections nested more than 8 deep (8 are fine), and a very deep one without a stack overflow', () => {
    expect(checkTemplate(kind, nested(8, value)).problems).toEqual([]);
    expect(checkTemplate(kind, nested(9, value))).toMatchObject({ problems: ['Sections are nested too deeply (more than 8 levels)'], rendered: null });
    // (Past the size limit as well, for every kind: both are reported, and the walk still stops at the cap.)
    expect(checkTemplate(kind, nested(2_400, value)).problems).toContain('Sections are nested too deeply (more than 8 levels)');
    expect(() => renderPrompt(kind, nested(2_400, value), CALL)).toThrow(/refused/);
  });

  it('refuses a list section opened inside itself quickly, and renders nothing', () => {
    const spy = vi.spyOn(Mustache.Writer.prototype, 'render');
    try {
      const started = performance.now();
      const check = checkTemplate(kind, nested(30));
      expect(() => renderPrompt(kind, nested(30), SAMPLE_INPUT)).toThrow(/refused/);
      expect(performance.now() - started).toBeLessThan(250);
      expect(check.rendered).toBeNull();
      expect(check.problems).toContain('Sections are nested too deeply (more than 8 levels)');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['renders to nothing for this call', `{{^${value}}}x{{/${value}}}`, {}, 'empty_render'],
    ['renders past twice the size limit for this call', '{{company_name}}'.repeat(Math.floor(max / 16)), { companyName: 'C'.repeat(60) }, 'too_long'],
    ['cannot render (an unknown placeholder)', 'Hi {{frist_name}}', {}, 'render_error'],
    ['nests a list inside itself', nested(30), {}, 'render_error'],
  ] as const)('a saved template that %s: the call gets the default, and the hook is told why', (_label, template, over, reason) => {
    const onError = vi.fn();
    expect(build(saved(kind, template, over), onError)).toBe(build({ ...CALL, ...over }));
    expect(onError).toHaveBeenCalledWith(kind, reason);
  });
});
