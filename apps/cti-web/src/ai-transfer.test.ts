import { describe, expect, it } from 'vitest';
import { aiTransferLabel, TRANSFER_REASON_WORDS } from './ai-transfer';

describe('aiTransferLabel', () => {
  it('words a known transfer reason', () => {
    expect(aiTransferLabel('wants_offer')).toBe('AI transfer — wants an offer');
  });

  it('every reason cti-api sends has words', () => {
    expect(Object.keys(TRANSFER_REASON_WORDS).sort()).toEqual(['interested', 'legal_or_complex', 'question', 'wants_human', 'wants_offer']);
  });

  it('an unknown reason is shown with spaces instead of underscores', () => {
    expect(aiTransferLabel('some_new_reason')).toBe('AI transfer — some new reason');
  });

  it('no reason means no label, and a blank one is just "AI transfer"', () => {
    expect(aiTransferLabel(null)).toBeUndefined();
    expect(aiTransferLabel(undefined)).toBeUndefined();
    expect(aiTransferLabel('_')).toBe('AI transfer');
  });
});
