/**
 * The inbound agent's instructions (plan 2026-10-16 inbound agent testing): the org's saved `inbound` template, else
 * the owner's prompt (prompt-default-inbound.ts) verbatim, ALWAYS followed by the fixed line rules — the owner's prompt
 * asks for JSON at the end of the call, which on a live call would be spoken, so the rules tell the agent to ignore it
 * (the details are filled in from the transcript after the call, caller-details.ts). The rules come after a saved
 * template and after the default fallback alike.
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
/** The fixed rules for this caller: the fixed lines, then the number they are calling from (owner, 2026-10-16). */
const RULES = `${INBOUND_LINE_RULES}\n- The caller is calling from 619-555-0142.`;

describe('INBOUND_LINE_RULES', () => {
  it('is the exact fixed text', () => {
    expect(INBOUND_LINE_RULES).toBe(
      [
        '# How this phone line works (always applies)',
        '- This is a live phone call: everything you say is spoken aloud. Never say JSON, field names, brackets or tags.',
        '- There is nothing to write down during this call: the team gets a summary made from the conversation after you hang up. Never mention notes, saving or setting anything up, and never say a line about what you are about to do — just say it. Ignore any instruction above to output JSON or a summary at the end of the call.',
        '- When the caller says goodbye or has to go, say a short goodbye out loud first, then call end_call. Never end the call silently while they are still on the line.',
        '- Speak English only, every word, the whole call.',
      ].join('\n'),
    );
  });
});

describe('buildInboundInstructions', () => {
  it("no saved template: the owner's prompt verbatim, then the rules and the caller's number", () => {
    expect(buildInboundInstructions(INPUT)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${RULES}`);
    expect(buildInboundInstructions(withInbound(null))).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${RULES}`);
  });

  it('a saved inbound template is rendered over the call, then the rules and the caller\'s number', () => {
    const saved = 'You are {{agent_name}} at {{company_name}}. Caller: {{caller_number}}. Their time: {{local_time}}.';
    expect(buildInboundInstructions(withInbound(saved))).toBe(
      `You are Sam at I Buy SD. Caller: 619-555-0142. Their time: Friday 11:00 AM.\n\n${RULES}`,
    );
  });

  it("the caller's number is written like {{caller_number}}, and left out when it is not known", () => {
    expect(buildInboundInstructions({ ...INPUT, callerNumber: '+15125550100' })).toBe(
      `${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}\n- The caller is calling from ${promptView({ ...INPUT, callerNumber: '+15125550100' }).caller_number}.`,
    );
    expect(buildInboundInstructions({ ...INPUT, callerNumber: '+15125550100' })).toMatch(/\n- The caller is calling from 512-555-0100\.$/);
    for (const callerNumber of [null, undefined, '', 'anonymous']) {
      expect(buildInboundInstructions({ ...INPUT, callerNumber })).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
    }
  });

  it('a saved template that renders to nothing falls back to the default, still with the rules, and says why', () => {
    const onError = vi.fn();
    const noCaller = { ...withInbound('  {{caller_number}}\n'), callerNumber: null };
    expect(buildInboundInstructions(noCaller, onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${INBOUND_LINE_RULES}`);
    expect(onError).toHaveBeenCalledWith('inbound', 'empty_render');
    // A blank template is refused outright (it never passes the check), and falls back the same way.
    expect(buildInboundInstructions(withInbound('  \n '), onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${RULES}`);
  });

  it('a saved template that cannot render (an outbound-only placeholder) falls back too, with the rules', () => {
    const onError = vi.fn();
    expect(buildInboundInstructions(withInbound('Hi {{first_name}}'), onError)).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${RULES}`);
    expect(onError).toHaveBeenCalledWith('inbound', 'render_error');
  });

  it('the outbound instructions never get the inbound rules or the inbound template', () => {
    const outbound = buildInstructions({ ...withInbound('INBOUND ONLY'), firstName: 'Jane', callbackNumber: '+15125550100' });
    expect(outbound).not.toContain(INBOUND_LINE_RULES);
    expect(outbound).not.toContain('The caller is calling from');
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
