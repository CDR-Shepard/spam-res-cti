/**
 * The AI transfer on the ring screen. AI calls start from outreach campaigns; when the
 * engine (services/cti-api/src/ai-voice) hands a call to a rep it rings through the normal
 * incoming path with an `aiTransfer` call parameter, which IncomingScreen shows in words.
 */

/** services/cti-api/src/ai-voice/prompt-tools.ts TRANSFER_REASONS, in words. */
export const TRANSFER_REASON_WORDS: Readonly<Record<string, string>> = {
  interested: 'interested',
  wants_offer: 'wants an offer',
  wants_human: 'asked for a person',
  legal_or_complex: 'legal or complex question',
  question: 'has a question',
};

/** "AI transfer — wants an offer" for the `aiTransfer` call parameter, else undefined. */
export function aiTransferLabel(reason: string | null | undefined): string | undefined {
  if (reason == null) return undefined;
  const words = TRANSFER_REASON_WORDS[reason] ?? reason.replace(/_/g, ' ').trim();
  return words ? `AI transfer — ${words}` : 'AI transfer';
}
