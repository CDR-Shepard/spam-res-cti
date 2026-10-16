import { describe, expect, it } from 'vitest';
import {
  AGENT_PROMPT_MAX_CHARS,
  AgentPromptCheck,
  AgentPromptKind,
  AgentPromptPlaceholder,
  AgentPromptPreviewRequest,
  AgentPromptSaveRequest,
  AgentPromptState,
  AgentPromptVersionBody,
  AgentPromptVersionSummary,
  AgentPromptsResponse,
  INTERNAL_AI_PROMPT_CHECK_PATH,
  InternalAgentPromptCheckRequest,
} from './agent-prompts.js';
import * as contracts from './index.js';
import { INTERNAL_AI_CALLS_PATH } from './ai-calls.js';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const AT = '2026-10-16T12:00:00.000Z';
const placeholder = { name: 'agent_name', kind: 'text', description: 'The name the agent gives on the call.' };
const summary = { id: ID, createdAt: AT, createdByEmail: 'admin@example.com', isDefault: false, chars: 1_234 };
const state = (kind: 'instructions' | 'voicemail') => ({
  kind,
  active: 'You are {{agent_name}}.',
  defaultTemplate: 'You are {{agent_name}}, built in.',
  placeholders: [placeholder],
  updatedAt: AT,
  updatedByEmail: 'admin@example.com',
  versions: [summary],
});

describe('AgentPromptKind', () => {
  it('accepts the two kinds', () => {
    expect(AgentPromptKind.parse('instructions')).toBe('instructions');
    expect(AgentPromptKind.parse('voicemail')).toBe('voicemail');
    expect(AgentPromptKind.options).toEqual(['instructions', 'voicemail']);
  });

  it.each([['system'], [''], [null], [1]])('rejects %j', (value) => {
    expect(AgentPromptKind.safeParse(value).success).toBe(false);
  });
});

describe('AGENT_PROMPT_MAX_CHARS', () => {
  it('is 60,000 for instructions and 1,500 for the voicemail', () => {
    expect(AGENT_PROMPT_MAX_CHARS).toEqual({ instructions: 60_000, voicemail: 1_500 });
  });
});

describe('AgentPromptPlaceholder', () => {
  it.each([['text'], ['section']])('accepts kind %s', (kind) => {
    expect(AgentPromptPlaceholder.safeParse({ ...placeholder, kind }).success).toBe(true);
  });

  it('rejects an unknown kind and a missing description', () => {
    expect(AgentPromptPlaceholder.safeParse({ ...placeholder, kind: 'list' }).success).toBe(false);
    expect(AgentPromptPlaceholder.safeParse({ name: 'x', kind: 'text' }).success).toBe(false);
  });
});

describe('AgentPromptCheck (cti-api answer)', () => {
  const check = { defaultTemplate: 'Hello', placeholders: [placeholder], rendered: 'Hello there', problems: [] };

  it('accepts a rendered check and a refused one (rendered null with problems)', () => {
    expect(AgentPromptCheck.parse(check)).toEqual(check);
    const refused = { ...check, rendered: null, problems: ['Unknown placeholder {{nope}}.'] };
    expect(AgentPromptCheck.parse(refused)).toEqual(refused);
  });

  it('rejects a missing field and a non-string problem', () => {
    const { rendered: _rendered, ...withoutRendered } = check;
    expect(AgentPromptCheck.safeParse(withoutRendered).success).toBe(false);
    expect(AgentPromptCheck.safeParse({ ...check, problems: [1] }).success).toBe(false);
  });
});

describe('InternalAgentPromptCheckRequest and its path', () => {
  it('uses the existing /internal/ai-calls prefix', () => {
    expect(INTERNAL_AI_PROMPT_CHECK_PATH).toBe('/internal/ai-calls/prompt-check');
    expect(INTERNAL_AI_PROMPT_CHECK_PATH.startsWith(`${INTERNAL_AI_CALLS_PATH}/`)).toBe(true);
  });

  it('accepts a template or null (the built-in default)', () => {
    expect(InternalAgentPromptCheckRequest.parse({ kind: 'voicemail', template: 'Hi' })).toEqual({ kind: 'voicemail', template: 'Hi' });
    expect(InternalAgentPromptCheckRequest.parse({ kind: 'instructions', template: null })).toEqual({ kind: 'instructions', template: null });
  });

  it('rejects an unknown kind and an undefined template', () => {
    expect(InternalAgentPromptCheckRequest.safeParse({ kind: 'system', template: 'x' }).success).toBe(false);
    expect(InternalAgentPromptCheckRequest.safeParse({ kind: 'voicemail' }).success).toBe(false);
  });

  it('is strict, like the other internal requests: an extra field is refused', () => {
    expect(InternalAgentPromptCheckRequest.safeParse({ kind: 'voicemail', template: null, orgId: ID }).success).toBe(false);
  });
});

describe('AgentPromptVersionSummary', () => {
  it('accepts a version and one with no author', () => {
    expect(AgentPromptVersionSummary.parse(summary)).toEqual(summary);
    expect(AgentPromptVersionSummary.safeParse({ ...summary, createdByEmail: null, isDefault: true, chars: 0 }).success).toBe(true);
  });

  it('rejects a negative or fractional chars and a bad id', () => {
    expect(AgentPromptVersionSummary.safeParse({ ...summary, chars: -1 }).success).toBe(false);
    expect(AgentPromptVersionSummary.safeParse({ ...summary, chars: 1.5 }).success).toBe(false);
    expect(AgentPromptVersionSummary.safeParse({ ...summary, id: 'nope' }).success).toBe(false);
  });
});

describe('AgentPromptState and AgentPromptsResponse', () => {
  it('accepts a customised state and a default one (active null, never saved)', () => {
    expect(AgentPromptState.parse(state('instructions'))).toEqual(state('instructions'));
    const fresh = { ...state('voicemail'), active: null, updatedAt: null, updatedByEmail: null, versions: [] };
    expect(AgentPromptState.parse(fresh)).toEqual(fresh);
  });

  it('holds at most the newest 20 versions', () => {
    const versions = (n: number) => Array.from({ length: n }, () => summary);
    expect(AgentPromptState.safeParse({ ...state('instructions'), versions: versions(20) }).success).toBe(true);
    expect(AgentPromptState.safeParse({ ...state('instructions'), versions: versions(21) }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(AgentPromptState.safeParse({ ...state('instructions'), kind: 'system' }).success).toBe(false);
  });

  it('the response carries both kinds', () => {
    const response = { instructions: state('instructions'), voicemail: state('voicemail') };
    expect(AgentPromptsResponse.parse(response)).toEqual(response);
    expect(AgentPromptsResponse.safeParse({ instructions: state('instructions') }).success).toBe(false);
  });
});

describe('AgentPromptSaveRequest', () => {
  it('accepts a template and null (reset to the default)', () => {
    expect(AgentPromptSaveRequest.parse({ template: 'You are {{agent_name}}.' })).toEqual({ template: 'You are {{agent_name}}.' });
    expect(AgentPromptSaveRequest.parse({ template: null })).toEqual({ template: null });
  });

  it('rejects a number and a missing template', () => {
    expect(AgentPromptSaveRequest.safeParse({ template: 1 }).success).toBe(false);
    expect(AgentPromptSaveRequest.safeParse({}).success).toBe(false);
  });
});

describe('AgentPromptPreviewRequest', () => {
  it('needs a string template', () => {
    expect(AgentPromptPreviewRequest.parse({ template: 'Hi' })).toEqual({ template: 'Hi' });
    expect(AgentPromptPreviewRequest.safeParse({ template: null }).success).toBe(false);
    expect(AgentPromptPreviewRequest.safeParse({}).success).toBe(false);
  });
});

describe('AgentPromptVersionBody', () => {
  it('accepts a body and a null body (a reset to the default)', () => {
    expect(AgentPromptVersionBody.parse({ id: ID, body: 'Hi' })).toEqual({ id: ID, body: 'Hi' });
    expect(AgentPromptVersionBody.parse({ id: ID, body: null })).toEqual({ id: ID, body: null });
  });

  it('rejects a bad id and a missing body', () => {
    expect(AgentPromptVersionBody.safeParse({ id: 'nope', body: 'Hi' }).success).toBe(false);
    expect(AgentPromptVersionBody.safeParse({ id: ID }).success).toBe(false);
  });
});

describe('contracts index', () => {
  it('exports the agent prompt contracts', () => {
    expect(contracts.AgentPromptKind).toBe(AgentPromptKind);
    expect(contracts.AGENT_PROMPT_MAX_CHARS).toBe(AGENT_PROMPT_MAX_CHARS);
    expect(contracts.INTERNAL_AI_PROMPT_CHECK_PATH).toBe(INTERNAL_AI_PROMPT_CHECK_PATH);
    expect(contracts.AgentPromptsResponse).toBe(AgentPromptsResponse);
  });
});
