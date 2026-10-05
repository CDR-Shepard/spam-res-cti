import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TriageResult } from '@cti/contracts';
import { caseToBundle, EvalCases, scoreCase, type EvalCase } from './eval.js';

const RESULT: TriageResult = { summary: 'Seller prefers texts.', channels: [{ channel: 'sms', reason: 'prefers text' }], timing: null, tags: [], doNotContact: null };
const CASE: EvalCase = { id: 'c', description: 'd', notes: [], tasks: [], acceptFirstChannel: ['sms'], acceptDoNotContact: [null] };

describe('triage eval set', () => {
  it('has at least 12 valid cases with unique ids, covering every do-not-contact category the set expects', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('./eval-cases.json', import.meta.url), 'utf8'));
    const cases = EvalCases.parse(raw);
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const flagged = new Set(cases.flatMap((c) => c.acceptDoNotContact.filter((x) => x !== null)));
    for (const category of ['sold', 'attorney', 'deceased', 'asked_no_contact', 'listed_with_agent', 'hostile', 'other']) {
      expect(flagged.has(category as never)).toBe(true);
    }
    expect(cases.some((c) => c.notes.length === 0 && c.tasks.length === 0)).toBe(true);
  });

  it('turns a case into a notes bundle with 18-character Task ids and no blank fields', () => {
    const bundle = caseToBundle({ ...CASE, notes: [{ name: 'Notes__c', value: 'x' }, { name: 'Description', value: '  ' }], tasks: [{ subject: 'Call', description: null, activityDate: null }] });
    expect(bundle.fields).toEqual([{ name: 'Notes__c', value: 'x' }]);
    expect(bundle.tasks[0]!.id).toBe('00T000000000000001');
  });

  it.each([
    ['matching channel and no flag', CASE, RESULT, true],
    ['wrong first channel', { ...CASE, acceptFirstChannel: ['call'] as EvalCase['acceptFirstChannel'] }, RESULT, false],
    ['empty channels accepted as null', { ...CASE, acceptFirstChannel: [null] as EvalCase['acceptFirstChannel'] }, { ...RESULT, channels: [] }, true],
    ['unscored channel', { ...CASE, acceptFirstChannel: undefined, acceptDoNotContact: ['sold'] as EvalCase['acceptDoNotContact'] }, { ...RESULT, doNotContact: { category: 'sold' as const, quote: 'sold the house' } }, true],
    ['missing flag', { ...CASE, acceptFirstChannel: undefined, acceptDoNotContact: ['sold'] as EvalCase['acceptDoNotContact'] }, RESULT, false],
    ['unexpected flag', CASE, { ...RESULT, doNotContact: { category: 'hostile' as const, quote: 'angry' } }, false],
  ])('scores %s', (_name, c, result, pass) => {
    expect(scoreCase(c, result).pass).toBe(pass);
  });
});
