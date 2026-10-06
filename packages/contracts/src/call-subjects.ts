/**
 * Plan 1D: how outreach-api's research reads back the call Task subjects cti-api writes, to tell a call that reached a
 * person from one that did not (research/last-contact.ts). The formats are cti-api's: salesforce/call-subject.ts
 * buildCallSubject ("<Inbound|Outbound> Call | <disposition> | <who>"; an inbound call with no disposition has no middle
 * part) and ai-voice/sf-logging ("AI call: <outcome words>", outcomes.ts OUTCOME_WORDS). cti-api's own tests run these
 * readers over what it writes (sweep D-13 drift guard), so a change on either side fails a test instead of the plans.
 */

/** A CTI call subject: "<Inbound|Outbound> Call | …". */
export const CTI_CALL_SUBJECT = /^(?:inbound|outbound) call \| /i;
/** Any AI call Task: the call's own ("AI call: <outcome words>") and its callback to-do ("AI call: callback …"). */
export const AI_CALL_SUBJECT = /^ai call\b/i;
/** An AI call Task whose outcome was a conversation (a person was reached and spoke). */
export const AI_CONVERSATION_SUBJECT = /^ai call:\s*(?:transferred to rep|callback requested|not interested|do not call|transfer missed|appointment set)\b/i;

/** The disposition part of a CTI call subject; null when it is not one, or has none (an inbound call without one). */
export function ctiSubjectDisposition(subject: string): string | null {
  if (!CTI_CALL_SUBJECT.test(subject)) return null;
  const parts = subject.split('|').map((p) => p.trim());
  return parts.length >= 3 ? (parts[1] ?? null) : null;
}
