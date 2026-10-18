/**
 * What the AI phone agent is told, and the tools it may call.
 *
 * The instructions and the voicemail text are Mustache templates (prompt-template.ts) rendered over the
 * call's data (prompt-view.ts): an org's saved version when it has one, else the built-in default
 * (prompt-default-instructions.ts, prompt-default-voicemail.ts), which reproduces byte for byte the text
 * this module built before templates existed.
 *
 * Record values (first name, address) come from Salesforce and are flattened to one line with markup
 * characters stripped; CRM notes are fenced as data, capped, and any forged fence tag inside them is
 * neutralised, so nothing a record says can become an instruction (prompt-context.ts).
 *
 * TCPA (47 CFR 64.1200(b)(2)): an artificial-voice message must state a telephone number, so when
 * `callbackNumber` is given the default voicemail ends with it and the live agent gives it before every
 * non-transfer goodbye.
 *
 * Inbound agent testing (plan 2026-10-16): when a test phone calls one of the AI's numbers, the agent follows the
 * `inbound` template (the owner's prompt by default, prompt-default-inbound.ts), always followed by the fixed
 * INBOUND_LINE_RULES, which no saved template can remove: they tell the agent there is nothing to write down on the
 * call (the details are filled in from the transcript afterwards) and to ignore the prompt's spoken-JSON ending. When
 * the caller's number is known, one more fixed line tells the agent what it is.
 */
import type { AgentPromptKind, AppointmentSlot } from '@cti/contracts';
import { phoneForms } from './prompt-context.js';
import { PLAN_PROMPT_MAX } from './prompt-plan.js';
import { DEFAULT_TEMPLATES, renderMaxChars, renderPrompt } from './prompt-template.js';
import { AI_CALL_TOOLS, INBOUND_TOOLS, TOOL_NAMES, WAIT_FOR_USER, toolsFor, type RealtimeFunctionTool, type ToolName } from './prompt-tools.js';

export { AI_CALL_TOOLS, INBOUND_TOOLS, PLAN_PROMPT_MAX, TOOL_NAMES, WAIT_FOR_USER, toolsFor, type RealtimeFunctionTool, type ToolName };

export interface PromptInput {
  agentName: string;
  companyName: string;
  firstName: string | null;
  address: string | null;
  notes: string;
  isTest: boolean;
  /** e.g. "Tuesday 4:12 PM" in the recipient's zone. */
  localTime: string;
  /** E.164 number people can call back on (the call's caller-ID DID); null omits every mention. */
  callbackNumber: string | null;
  /** The plan a person approved for this call (plan 1C, prompt-plan.ts); absent/null = none. */
  approvedPlan?: string | null;
  /** Plan 1D: we have spoken with this seller before (the plan's re-engagement says when). */
  returning?: boolean;
  /** Plan 1D: appointment times the agent may offer and book (structured; never plan text). */
  slots?: readonly AppointmentSlot[];
  /** Plan 1D: the zone of the number dialed (`timezoneForNumber(to)`); slot times are said in it. */
  sellerTimeZone?: string | null;
  /** Inbound only (a test phone called the AI): the caller's E.164 number; absent/null = none. */
  callerNumber?: string | null;
  /** The org's saved templates; null (or absent) = the built-in default for that kind. */
  templates?: { instructions: string | null; voicemail: string | null; inbound?: string | null };
}

/** Why a saved template was not used: it threw, rendered nothing for this call, or rendered past twice its size limit. */
export type TemplateErrorReason = 'render_error' | 'empty_render' | 'too_long';

/** Called with the kind whose saved template was not used (the default was used instead) and why. */
export type TemplateErrorHandler = (kind: AgentPromptKind, reason: TemplateErrorReason) => void;

/** Why `out` (a saved template's render) must not reach the call, or null when it can. */
function unusableReason(kind: AgentPromptKind, out: string): TemplateErrorReason | null {
  if (out.trim() === '') return 'empty_render';
  return out.length > renderMaxChars(kind) ? 'too_long' : null;
}

/**
 * The call's saved template for `kind` rendered over its data, else the built-in default. A prompt never
 * breaks a call: a saved template that fails to render, or renders to nothing (a block whose data this call
 * lacks) or to a runaway length, falls back to the default, and `onTemplateError` (the caller's logger; never
 * given the template or the call's data) is told which kind and why.
 */
function promptText(kind: AgentPromptKind, p: PromptInput, onTemplateError?: TemplateErrorHandler): string {
  const saved = p.templates?.[kind];
  if (typeof saved === 'string') {
    let reason: TemplateErrorReason;
    try {
      const out = renderPrompt(kind, saved, p);
      const unusable = unusableReason(kind, out);
      if (unusable === null) return out;
      reason = unusable;
    } catch {
      reason = 'render_error';
    }
    try {
      onTemplateError?.(kind, reason);
    } catch {
      // A failing logger must not take the call down with it: the default below keeps it going.
    }
  }
  return renderPrompt(kind, DEFAULT_TEMPLATES[kind], p);
}

/** The Realtime session instructions for one AI call. */
export function buildInstructions(p: PromptInput, onTemplateError?: TemplateErrorHandler): string {
  return promptText('instructions', p, onTemplateError);
}

/** The voicemail `<Say>` text (≈ 20 s; the default names no price and no ZIP code). */
export function voicemailText(p: PromptInput, onTemplateError?: TemplateErrorHandler): string {
  return promptText('voicemail', p, onTemplateError);
}

/** Appended after the inbound prompt on every inbound call, saved template or default: not editable. */
export const INBOUND_LINE_RULES = [
  '# How this phone line works (always applies)',
  '- This is a live phone call: everything you say is spoken aloud. Never say JSON, field names, brackets or tags.',
  '- There is nothing to write down during this call: the team gets a summary made from the conversation after you hang up. Never mention notes, saving or setting anything up, and never say a line about what you are about to do — just say it. Ignore any instruction above to output JSON or a summary at the end of the call.',
  '- If the caller wants to go, or once you have said goodbye, call end_call.',
  '- Speak English only, every word, the whole call.',
].join('\n');

/**
 * The line rules for this call: INBOUND_LINE_RULES, then — when the caller's number is known — the number they are calling
 * from, written as {{caller_number}} writes it (the owner's prompt asks the agent to confirm a callback number that is not
 * that one, which it could not do without being told it).
 */
function inboundLineRules(callerNumber: string | null | undefined): string {
  const written = phoneForms(callerNumber ?? null)?.written;
  return written ? `${INBOUND_LINE_RULES}\n- The caller is calling from ${written}.` : INBOUND_LINE_RULES;
}

/** The Realtime session instructions for an inbound call: the inbound template (saved, else the default), then the line rules. */
export function buildInboundInstructions(p: PromptInput, onTemplateError?: TemplateErrorHandler): string {
  return `${promptText('inbound', p, onTemplateError)}\n\n${inboundLineRules(p.callerNumber)}`;
}
