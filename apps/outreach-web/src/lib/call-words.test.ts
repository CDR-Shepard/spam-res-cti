import { describe, expect, it } from 'vitest';
import { AiConsentStatus, CallGoalKey, CallStage, EvidenceSource, PreferredWindow, ResearchSource, ResearchSourceStatus } from '@cti/contracts';
import { CALL_STAGE_WORDS, CONSENT_WORDS, EVIDENCE_WORDS, GOAL_WORDS, SOURCE_STATUS_WORDS, SOURCE_WORDS, STRENGTH_WORDS, WINDOW_WORDS, sourceLine } from './call-words';

describe('sourceLine', () => {
  it('words a missing source', () => {
    expect(sourceLine({ source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' })).toBe('Chatter: not available in this org');
  });
  it('words a read source, and says when only the most recent were kept', () => {
    expect(sourceLine({ source: 'tasks', status: 'ok', count: 25, truncated: true, note: null })).toBe('Tasks: 25 (most recent)');
    expect(sourceLine({ source: 'notes', status: 'ok', count: 3, truncated: false, note: null })).toBe('Notes: 3');
  });
});

describe('word tables', () => {
  const tables: Array<[string, readonly string[], Record<string, string>]> = [
    ['CALL_STAGE_WORDS', CallStage.options, CALL_STAGE_WORDS],
    ['GOAL_WORDS', CallGoalKey.options, GOAL_WORDS],
    ['WINDOW_WORDS', PreferredWindow.options, WINDOW_WORDS],
    ['SOURCE_WORDS', ResearchSource.options, SOURCE_WORDS],
    ['EVIDENCE_WORDS', EvidenceSource.options, EVIDENCE_WORDS],
    ['SOURCE_STATUS_WORDS', ResearchSourceStatus.options, SOURCE_STATUS_WORDS],
    ['CONSENT_WORDS', AiConsentStatus.options, CONSENT_WORDS],
    ['STRENGTH_WORDS', ['strong', 'moderate', 'weak'], STRENGTH_WORDS],
  ];
  it.each(tables)('%s has a non-empty word for every key', (_name, keys, words) => {
    for (const key of keys) expect(words[key]?.length ?? 0, key).toBeGreaterThan(0);
  });

  it('never words an unreadable consent as consent', () => {
    expect(CONSENT_WORDS.unknown).toBe('AI consent: could not be read — research again');
  });
});
