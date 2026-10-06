import { describe, expect, it } from 'vitest';
import { evidenceJustifies, moneyCandidates } from './money-evidence.js';

describe('moneyCandidates: digits', () => {
  it.each<[string, number[]]>([
    ['350,000 at least', [350_000]],
    ['$350,000', [350_000]],
    ['about 250k', [250_000]],
    ['around 250 K', [250_000]],
    ['350 thousand', [350_000]],
    ['1.2 million', [1_200_000]],
    ['$1.2M', [1_200_000]],
    ['2 mil', [2_000_000]],
    ['forty or 40 grand', [40_000]],
    ['between 200 and 250k', [200, 250_000]],
    ['350 miles away', [350]],
    ['I owe 200,000, and the rest is mine', [200_000]],
  ])('%j → %j', (evidence, expected) => {
    expect(moneyCandidates(evidence)).toEqual(expected);
  });
});

describe('moneyCandidates: words need a magnitude', () => {
  it.each<[string, number[]]>([
    ['yeah that one works', []],
    ['I have two kids', []],
    ['three fifty', []],
    ['three hundred grand', [300_000]],
    ['owe like forty grand', [40_000]],
    ['two fifty thousand', [250_000]],
    ['a quarter million', [250_000]],
    ['half a million', [500_000]],
    ['a half million', [500_000]],
    ['two and a half million', [2_500_000]],
    ['a million', [1_000_000]],
    ['four hundred thousand', [400_000]],
    ['three hundred fifty thousand', [350_000]],
    ['three hundred and fifty thousand', [350_000]],
    ['a hundred and fifty thousand', [150_000]],
    ['three twenty-five thousand', [325_000]],
    ['one million two hundred thousand', [1_200_000]],
    ['one point two million', [1_200_000]],
    ['I owe about ninety five thousand on it', [95_000]],
    ['two hundred dollars', [200]],
  ])('%j → %j', (evidence, expected) => {
    expect(moneyCandidates(evidence)).toEqual(expected);
  });
  it.each(['two three hundred thousand', 'twenty thirty thousand', 'thousand million', 'fifteen five thousand', 'two hundred thousand million'])('%j cannot be parsed confidently → none', (evidence) => {
    expect(moneyCandidates(evidence)).toEqual([]);
  });
});

describe('evidenceJustifies', () => {
  it.each<[string, number, boolean]>([
    ['yeah that one works', 1_000, false],
    ['yeah that one works', 1_000_000, false],
    ['I have two kids', 2_000, false],
    ['about 250k', 250_000, true],
    ['about 250k', 300_000, false],
    ['three hundred grand', 300_000, true],
    ['three hundred grand', 3_000, false],
    ['1.2 million', 1_200_000, true],
    ['1.2 million', 1_000_000, false],
    ['owe like forty grand', 40_000, true],
    ['owe like forty grand', 400_000, false],
    ['350', 350_000, false],
    ['three fifty', 350_000, false],
  ])('%j justifies %d: %s', (evidence, value, expected) => {
    expect(evidenceJustifies(evidence, value)).toBe(expected);
  });
  it('a number with digits is read from the digits only, never from words beside them', () => {
    expect(evidenceJustifies('2 hundred thousand', 200_000)).toBe(false);
  });
});
