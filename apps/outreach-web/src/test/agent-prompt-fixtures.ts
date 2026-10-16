import type { AgentPromptKind, AgentPromptState, AgentPromptsResponse, AgentPromptVersionSummary } from '@cti/contracts';

export const VERSION_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
export const VERSION_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
export const SAVED_AT = '2026-10-16T19:42:00.000Z';

export const DEFAULT_INSTRUCTIONS = 'You are {{agent_name}}, calling for {{company_name}}.';
export const DEFAULT_VOICEMAIL = 'Hi, this is {{agent_name}} calling for {{company_name}}.';

const DEFAULTS: Readonly<Record<AgentPromptKind, string>> = { instructions: DEFAULT_INSTRUCTIONS, voicemail: DEFAULT_VOICEMAIL };

export function version(over: Partial<AgentPromptVersionSummary> = {}): AgentPromptVersionSummary {
  return { id: VERSION_A, createdAt: SAVED_AT, createdByEmail: 'grant@gghomes.com', isDefault: false, chars: 120, ...over };
}

/** One kind's state: nothing saved yet (the built-in default is in use) unless `over` says otherwise. */
export function promptState(kind: AgentPromptKind, over: Partial<AgentPromptState> = {}): AgentPromptState {
  return {
    kind,
    active: null,
    defaultTemplate: DEFAULTS[kind],
    placeholders: [
      { name: 'agent_name', kind: 'text', description: 'the name the agent introduces itself with' },
      { name: 'company_name', kind: 'text', description: "your company's name as the agent says it" },
      { name: 'call_plan', kind: 'section', description: 'the call plan your team approved for this call' },
    ],
    updatedAt: null,
    updatedByEmail: null,
    versions: [],
    ...over,
  };
}

export function promptsResponse(over: Partial<AgentPromptsResponse> = {}): AgentPromptsResponse {
  return { instructions: promptState('instructions'), voicemail: promptState('voicemail'), ...over };
}
