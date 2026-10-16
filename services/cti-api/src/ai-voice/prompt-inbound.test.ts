/**
 * The inbound agent's instructions (plan 2026-10-16 inbound agent testing): the org's saved `inbound` template, else
 * the owner's prompt (prompt-default-inbound.ts) verbatim, ALWAYS followed by the fixed line rules — the owner's prompt
 * asks for JSON at the end of the call, which on a live call would be spoken, so the rules turn it into silent
 * save_caller_details calls. The rules come after a saved template and after the default fallback alike.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_INBOUND_TEMPLATE } from './prompt-default-inbound.js';
import { DEFAULT_TEMPLATES, PLACEHOLDERS, SAMPLE_INPUT, checkTemplate } from './prompt-template.js';
import { promptView } from './prompt-view.js';
import { INBOUND_LINE_RULES, buildInboundInstructions, buildInstructions, type PromptInput } from './prompt.js';

const CALLER = '+16195550142';
const INPUT: PromptInput = {
  agentName: 'Sam',
  companyName: 'I Buy SD',
  firstName: null,
  address: null,
  notes: '',
  isTest: true,
  localTime: 'Friday 11:00 AM',
  callbackNumber: null,
  callerNumber: CALLER,
};
const withInbound = (inbound: string | null): PromptInput => ({ ...INPUT, templates: { instructions: null, voicemail: null, inbound } });

describe('INBOUND_LINE_RULES', () => {
  it('is the exact fixed text', () => {
    expect(INBOUND_LINE_RULES).toBe(
      [
        '# How this phone line works (always applies)',
        '- This is a live phone call: everything you say is spoken aloud. Never say JSON, field names, brackets or tags.',
        '- Save what the caller tells you with the save_caller_details tool, silently, as you learn it — call it in the same reply as your next sentence or question, never announce it, and call it once more with "status" before you say goodbye. This replaces any instruction above to output JSON or a summary at the end of the call.',
        '- If the caller wants to go, or once you have said goodbye, call end_call.',
      ].join('\n'),
    );
  });
});

describe('buildInboundInstructions', () => {
  it("no saved template: the owner's prompt verbatim, then the rules", () => {
    expect(buildInboundInstructions(INPUT)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
    expect(buildInboundInstructions(withInbound(null))).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
  });

  it('a saved inbound template is rendered over the call, then the rules', () => {
    const saved = 'You are {{agent_name}} at {{company_name}}. Caller: {{caller_number}}. Their time: {{local_time}}.';
    expect(buildInboundInstructions(withInbound(saved))).toBe(
      `You are Sam at I Buy SD. Caller: 619-555-0142. Their time: Friday 11:00 AM.\n\n${INBOUND_LINE_RULES}`,
    );
  });

  it('a saved template that renders to nothing falls back to the default, still with the rules, and says why', () => {
    const onError = vi.fn();
    const noCaller = { ...withInbound('  {{caller_number}}\n'), callerNumber: null };
    expect(buildInboundInstructions(noCaller, onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
    expect(onError).toHaveBeenCalledWith('inbound', 'empty_render');
    // A blank template is refused outright (it never passes the check), and falls back the same way.
    expect(buildInboundInstructions(withInbound('  \n '), onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
  });

  it('a saved template that cannot render (an outbound-only placeholder) falls back too, with the rules', () => {
    const onError = vi.fn();
    expect(buildInboundInstructions(withInbound('Hi {{first_name}}'), onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
    expect(onError).toHaveBeenCalledWith('inbound', 'render_error');
  });

  it('the outbound instructions never get the inbound rules or the inbound template', () => {
    const outbound = buildInstructions({ ...withInbound('INBOUND ONLY'), firstName: 'Jane', callbackNumber: '+15125550100' });
    expect(outbound).not.toContain(INBOUND_LINE_RULES);
    expect(outbound).not.toContain('INBOUND ONLY');
    expect(outbound).toBe(buildInstructions({ ...INPUT, firstName: 'Jane', callbackNumber: '+15125550100', templates: { instructions: null, voicemail: null } }));
  });
});

describe('the inbound kind in the template machinery', () => {
  it("the built-in default is the owner's prompt", () => {
    expect(DEFAULT_TEMPLATES.inbound).toBe(DEFAULT_INBOUND_TEMPLATE);
  });

  it('the default passes the check with no problems, rendering as written', () => {
    const check = checkTemplate('inbound', null);
    expect(check.problems).toEqual([]);
    expect(check.defaultTemplate).toBe(DEFAULT_INBOUND_TEMPLATE);
    expect(check.rendered).toBe(DEFAULT_INBOUND_TEMPLATE);
  });

  it('offers agent_name, company_name, caller_number and local_time, and refuses outbound-only names', () => {
    expect(PLACEHOLDERS.inbound.map((p) => p.name)).toEqual(['agent_name', 'company_name', 'caller_number', 'local_time']);
    const caller = PLACEHOLDERS.inbound.find((p) => p.name === 'caller_number');
    expect(caller).toEqual({ name: 'caller_number', kind: 'text', description: 'the number the caller is calling from, written like 619-555-0100' });
    const localTime = PLACEHOLDERS.inbound.find((p) => p.name === 'local_time');
    expect(localTime).toEqual(PLACEHOLDERS.instructions.find((p) => p.name === 'local_time'));
    expect(checkTemplate('inbound', 'Hi {{first_name}}').problems).toEqual(['Unknown placeholder: first_name']);
    expect(checkTemplate('instructions', 'Hi {{caller_number}}').problems).toEqual(['Unknown placeholder: caller_number']);
  });

  it('the sample call has a caller number, written like the callback number', () => {
    expect(SAMPLE_INPUT.callerNumber).toMatch(/^\+1\d{10}$/);
    expect(checkTemplate('inbound', 'From {{caller_number}}').rendered).toMatch(/^From \d{3}-\d{3}-\d{4}$/);
    expect(promptView(INPUT).caller_number).toBe('619-555-0142');
    expect(promptView({ ...INPUT, callerNumber: undefined }).caller_number).toBe('');
  });
});
