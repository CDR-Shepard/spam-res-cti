import { describe, expect, it } from 'vitest';
import { recordIdFromRow, soqlEscape } from './soql.js';

describe('soqlEscape (same behavior as cti-api salesforce/soql.ts)', () => {
  it.each([
    ["O'Brien", "O\\'Brien"],
    ['a\\b', 'a\\\\b'],
    ['00Q123', '00Q123'],
    ['', ''],
    ["\\'", "\\\\\\'"], // backslash first, then the quote: no double escaping
    ["x' OR Name != '", "x\\' OR Name != \\'"],
  ])('%j → %j', (input, expected) => {
    expect(soqlEscape(input)).toBe(expected);
  });
});

describe('recordIdFromRow', () => {
  it('uses the selected Id', () => {
    expect(recordIdFromRow({ Id: '00Q5e00000AbCdEAAZ' })).toBe('00Q5e00000AbCdEAAZ');
  });

  it('accepts a 15-character Id', () => {
    expect(recordIdFromRow({ Id: '00Q5e00000AbCdE' })).toBe('00Q5e00000AbCdE');
  });

  it('reads the Id from attributes.url when the query did not select Id', () => {
    expect(
      recordIdFromRow({ attributes: { url: '/services/data/v60.0/sobjects/Opportunity/006US00000DyV4hYAF' } }),
    ).toBe('006US00000DyV4hYAF');
  });

  it('falls back to attributes.url when Id is not a well-formed Id', () => {
    expect(
      recordIdFromRow({ Id: 42, attributes: { url: '/services/data/v60.0/sobjects/Lead/00Q5e00000AbCdEAAZ' } }),
    ).toBe('00Q5e00000AbCdEAAZ');
  });

  it('is null when neither holds an Id', () => {
    expect(recordIdFromRow({})).toBeNull();
    expect(recordIdFromRow({ attributes: { url: 42 } })).toBeNull();
    expect(recordIdFromRow({ attributes: { url: '/services/data/v60.0/sobjects/Lead/' } })).toBeNull();
    expect(recordIdFromRow({ attributes: { url: '/services/data/v60.0/sobjects/Lead/not-an-id' } })).toBeNull();
  });
});
