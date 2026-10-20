/**
 * The approved call plan (plan 1C) as the agent's instructions carry it.
 *
 * outreach-api sends the plan a person approved; cti-api's internal route refuses one that
 * fails the CF-9 check (`agentPlanTextIssues`) before anything is dialed. This module checks
 * again — a failing plan is dropped, never fenced in — so no other path can put one in front
 * of the agent. A passing plan has any data-fence tag inside it made inert and is capped; the
 * instructions template fences it as quoted data, with the rules the plan can never override
 * after the fence (prompt-default-instructions.ts).
 */
import { agentPlanTextIssues } from '@cti/contracts';

/** The most plan text the instructions carry (the contract's PLAN_TEXT_MAX). */
export const PLAN_PROMPT_MAX = 4_000;

/**
 * Any opening or closing data-fence tag (notes, plan or the seller's conversation history) becomes inert text inside any of
 * the fences. Same length in, same length out for a tag without inner spaces, so a cap applied after it still holds.
 */
export function neutraliseFences(text: string): string {
  return text.replace(/<\s*(\/?)\s*(crm_notes|call_plan|conversation_history)\s*>/gi, '[$1$2]');
}

/** The plan as the instructions fence it, or null for none (no plan, blank, or failing CF-9). */
export function approvedPlanText(raw: string | null | undefined): string | null {
  if (!raw || agentPlanTextIssues(raw, { singleLine: false }).length > 0) return null;
  return neutraliseFences(raw).slice(0, PLAN_PROMPT_MAX).trim() || null;
}
