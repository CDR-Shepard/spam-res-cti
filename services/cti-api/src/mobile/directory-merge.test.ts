import { describe, expect, it } from 'vitest';
import { contentHash, mergeDirectory } from './directory-merge.js';

describe('mergeDirectory', () => {
  it('dedupes by number with deal > opp > lead and prefixes the stage', () => {
    expect(mergeDirectory([
      { e164: '+16195550100', name: 'Jane Doe', stage: 'lead' },
      { e164: '+16195550100', name: '123 Main St', stage: 'deal' },
      { e164: '+16195550100', name: '123 Main St - Wholetail', stage: 'opp' },
      { e164: '+12135550200', name: '456 Oak Ave', stage: 'opp' },
    ])).toEqual([
      { e164: '+12135550200', label: 'Opp: 456 Oak Ave', stage: 'opp' },
      { e164: '+16195550100', label: 'Deal: 123 Main St', stage: 'deal' },
    ]);
  });
  it('sorts ascending numerically and drops empty names', () => {
    const out = mergeDirectory([
      { e164: '+19998887777', name: 'Z', stage: 'lead' },
      { e164: '+12135550200', name: '  ', stage: 'deal' },
      { e164: '+16195550100', name: 'A', stage: 'lead' },
    ]);
    expect(out.map((e) => e.e164)).toEqual(['+16195550100', '+19998887777']);
  });
  it('same stage: first occurrence wins (stable)', () => {
    expect(mergeDirectory([
      { e164: '+16195550100', name: 'First', stage: 'lead' },
      { e164: '+16195550100', name: 'Second', stage: 'lead' },
    ])[0]!.label).toBe('Lead: First');
  });
  it('contentHash is stable across input order', () => {
    const a = mergeDirectory([{ e164: '+16195550100', name: 'A', stage: 'lead' }, { e164: '+12135550200', name: 'B', stage: 'opp' }]);
    const b = mergeDirectory([{ e164: '+12135550200', name: 'B', stage: 'opp' }, { e164: '+16195550100', name: 'A', stage: 'lead' }]);
    expect(contentHash(a)).toBe(contentHash(b));
  });
});
