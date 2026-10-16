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
import { AgentPromptCheck, type AgentPromptKind } from '@cti/contracts';
import { DEFAULT_INSTRUCTIONS_TEMPLATE } from './prompt-default-instructions.js';
import { DEFAULT_VOICEMAIL_TEMPLATE } from './prompt-default-voicemail.js';
import { neutraliseFences } from './prompt-plan.js';
import { PLACEHOLDERS, SAMPLE_INPUT, checkTemplate, renderPrompt } from './prompt-template.js';
import { promptView } from './prompt-view.js';
import { buildInstructions, voicemailText, type PromptInput } from './prompt.js';

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
};
const KINDS: readonly AgentPromptKind[] = ['instructions', 'voicemail'];

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
    const listFields = new Set(['time_id', 'time_kind', 'time_text']);
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
      expect(checkTemplate('instructions', `{{${p.name}}}`).problems.length > 0, p.name).toBe(blockOnly);
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
  it('is Jane at 1234 Oak St in Tampa, returning, with a plan, two times with Grant and a callback number, not a test call', () => {
    expect(SAMPLE_INPUT).toMatchObject({ firstName: 'Jane', isTest: false, returning: true });
    expect(SAMPLE_INPUT.address).toContain('1234 Oak St');
    expect(SAMPLE_INPUT.address).toContain('Tampa');
    expect(SAMPLE_INPUT.callbackNumber).toMatch(/^\+1\d{10}$/);
    expect(SAMPLE_INPUT.slots?.map((s) => s.specialistFirstName)).toEqual(['Grant', 'Grant']);
    const text = buildInstructions(SAMPLE_INPUT);
    expect(text).toContain('<call_plan>');
    expect(text).toContain("we've spoken before");
    expect(text).toContain('# Booking an appointment');
    expect(text).toContain('Grant, one of our specialists');
    expect(text).not.toContain('this is a test call');
  });
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

describe('PLACEHOLDERS', () => {
  it.each(KINDS)('%s: every placeholder the default uses is listed, and every listed one is used by the default', (kind) => {
    const used = namesIn(DEFAULTS[kind]);
    const listed = new Set(PLACEHOLDERS[kind].map((p) => p.name));
    expect([...used].filter((n) => !listed.has(n))).toEqual([]);
    expect([...listed].filter((n) => !used.has(n))).toEqual([]);
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
