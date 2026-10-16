/**
 * The org's saved agent prompts as the live call uses them (plan 2026-10-16 editable agent prompts): read when a
 * call is placed, never cached, so a saved version takes effect on the next call. A prompt never breaks a call:
 * an unreadable table means the built-in defaults, and a saved template that fails to render means the default
 * for that kind. Both are logged with a reason only; the logs never hold template text or any lead's data.
 */
import type { BridgeLog } from './bridge.js';
import type { TemplateErrorHandler } from './prompt.js';
import type { AgentPromptTemplates, AiCallStore } from './store.js';

const DEFAULT_TEMPLATES_IN_USE: AgentPromptTemplates = { instructions: null, voicemail: null };

/** The org's active templates, or `null` for both (the defaults) when they cannot be read. */
export async function loadAgentPrompts(store: AiCallStore, orgId: string, log: BridgeLog): Promise<AgentPromptTemplates> {
  try {
    return await store.activeAgentPrompts(orgId);
  } catch {
    log.warn({ reason: 'db_error' }, 'ai-voice: agent prompts unavailable, using defaults');
    return { ...DEFAULT_TEMPLATES_IN_USE };
  }
}

/** What buildInstructions / voicemailText tell when a saved template is not used: the kind and the reason (codes only). */
export function logTemplateError(log: BridgeLog): TemplateErrorHandler {
  return (kind, reason) => log.warn({ kind, reason }, 'ai-voice: custom prompt failed, using default');
}
