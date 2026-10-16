/**
 * Admin-editable agent prompts (plan docs/superpowers/plans/2026-10-16-editable-agent-prompts.md):
 * the AI phone agent's instructions, its voicemail message and its inbound prompt (what it follows when a
 * test phone calls it, plan 2026-10-16-inbound-agent-testing.md) are templates an admin edits, previews,
 * saves and resets. Versions are append-only rows in ai_agent_prompts (migration 0060); a NULL body is
 * "the built-in default". cti-api renders and checks templates (it owns the placeholders and the
 * defaults); outreach-api stores versions and serves the admin page.
 */
import { z } from 'zod';

/** Which of the agent's three texts a template is for. */
export const AgentPromptKind = z.enum(['instructions', 'voicemail', 'inbound']);
export type AgentPromptKind = z.infer<typeof AgentPromptKind>;

/** The longest template a save accepts, per kind (the voicemail is read aloud once, so it is short). */
export const AGENT_PROMPT_MAX_CHARS = { instructions: 60_000, voicemail: 1_500, inbound: 60_000 } as const;

/** How many versions a state lists (the newest). */
export const AGENT_PROMPT_VERSIONS_SHOWN = 20;

/** A name a template may use: text = a value ({{name}}), section = a block that may be shown or hidden. */
export const AgentPromptPlaceholder = z.object({
  name: z.string(),
  kind: z.enum(['text', 'section']),
  description: z.string(),
});
export type AgentPromptPlaceholder = z.infer<typeof AgentPromptPlaceholder>;

/**
 * cti-api's answer to "check this template": the built-in default and the placeholders for the kind,
 * the template rendered against a sample call (null when it was refused), and the plain-words reasons
 * it was refused (empty when it is fine).
 */
export const AgentPromptCheck = z.object({
  defaultTemplate: z.string(),
  placeholders: z.array(AgentPromptPlaceholder),
  rendered: z.string().nullable(),
  problems: z.array(z.string()),
});
export type AgentPromptCheck = z.infer<typeof AgentPromptCheck>;

/** outreach-api → cti-api. template null checks the built-in default for the kind. */
export const INTERNAL_AI_PROMPT_CHECK_PATH = '/internal/ai-calls/prompt-check';
export const InternalAgentPromptCheckRequest = z.object({ kind: AgentPromptKind, template: z.string().nullable() }).strict();
export type InternalAgentPromptCheckRequest = z.infer<typeof InternalAgentPromptCheckRequest>;

/** One saved version in the history list (the text itself is fetched on demand: AgentPromptVersionBody). */
export const AgentPromptVersionSummary = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  createdByEmail: z.string().nullable(),
  /** The version is a reset to the built-in default (body NULL). */
  isDefault: z.boolean(),
  chars: z.number().int().nonnegative(),
});
export type AgentPromptVersionSummary = z.infer<typeof AgentPromptVersionSummary>;

/** Everything the admin page needs for one kind. versions holds the newest 20. */
export const AgentPromptState = z.object({
  kind: AgentPromptKind,
  /** The saved template; null when the built-in default is in use. */
  active: z.string().nullable(),
  defaultTemplate: z.string(),
  placeholders: z.array(AgentPromptPlaceholder),
  updatedAt: z.string().nullable(),
  updatedByEmail: z.string().nullable(),
  versions: z.array(AgentPromptVersionSummary).max(AGENT_PROMPT_VERSIONS_SHOWN),
});
export type AgentPromptState = z.infer<typeof AgentPromptState>;

export const AgentPromptsResponse = z.object({
  instructions: AgentPromptState,
  voicemail: AgentPromptState,
  inbound: AgentPromptState,
});
export type AgentPromptsResponse = z.infer<typeof AgentPromptsResponse>;

/** Save a new version; template null resets the kind to the built-in default. */
export const AgentPromptSaveRequest = z.object({ template: z.string().nullable() });
export type AgentPromptSaveRequest = z.infer<typeof AgentPromptSaveRequest>;

/** Render a draft against a sample call without saving it. */
export const AgentPromptPreviewRequest = z.object({ template: z.string() });
export type AgentPromptPreviewRequest = z.infer<typeof AgentPromptPreviewRequest>;

/** One version's text (null body = the built-in default), to load an older version into the editor. */
export const AgentPromptVersionBody = z.object({ id: z.string().uuid(), body: z.string().nullable() });
export type AgentPromptVersionBody = z.infer<typeof AgentPromptVersionBody>;
