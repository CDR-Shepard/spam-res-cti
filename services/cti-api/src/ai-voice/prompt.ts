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
 */
import type { AgentPromptKind, AppointmentSlot } from '@cti/contracts';
import { PLAN_PROMPT_MAX } from './prompt-plan.js';
import { DEFAULT_TEMPLATES, renderPrompt } from './prompt-template.js';
import { AI_CALL_TOOLS, TOOL_NAMES, WAIT_FOR_USER, toolsFor, type RealtimeFunctionTool, type ToolName } from './prompt-tools.js';

export { AI_CALL_TOOLS, PLAN_PROMPT_MAX, TOOL_NAMES, WAIT_FOR_USER, toolsFor, type RealtimeFunctionTool, type ToolName };

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
  /** The org's saved templates; null (or absent) = the built-in default for that kind. */
  templates?: { instructions: string | null; voicemail: string | null };
}

/** Called with the kind whose saved template failed to render (the default was used instead). */
export type TemplateErrorHandler = (kind: AgentPromptKind) => void;

/**
 * The call's saved template for `kind` rendered over its data, else the built-in default. A prompt never
 * breaks a call: a saved template that fails to render falls back to the default, and `onTemplateError`
 * (the caller's logger; never given the template or the call's data) is told which kind failed.
 */
function promptText(kind: AgentPromptKind, p: PromptInput, onTemplateError?: TemplateErrorHandler): string {
  const saved = p.templates?.[kind];
  if (typeof saved === 'string') {
    try {
      return renderPrompt(kind, saved, p);
    } catch {
      try {
        onTemplateError?.(kind);
      } catch {
        // A failing logger must not take the call down with it: the default below keeps it going.
      }
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
