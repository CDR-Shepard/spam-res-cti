import { describe, expect, it } from 'vitest';
import { spokenFirstName } from './spoken-name.js';

describe('spokenFirstName', () => {
  it('keeps a plain first name, trimmed', () => {
    expect(spokenFirstName('  Jane ')).toBe('Jane');
    expect(spokenFirstName('Mary Ann')).toBe('Mary Ann');
    expect(spokenFirstName("D'Andre")).toBe("D'Andre");
    expect(spokenFirstName('Jean-Luc')).toBe('Jean-Luc');
    expect(spokenFirstName('José')).toBe('José');
  });

  it('two people on one record: the first one', () => {
    expect(spokenFirstName('John and Mary')).toBe('John');
    expect(spokenFirstName('John & Mary')).toBe('John');
    expect(spokenFirstName('John/Mary')).toBe('John');
    expect(spokenFirstName('John & Mary (Smith)')).toBe('John');
  });

  it('drops a note in brackets', () => {
    expect(spokenFirstName('Robert (Bob)')).toBe('Robert');
    expect(spokenFirstName('Robert ( son)')).toBe('Robert');
    expect(spokenFirstName('(Bob)')).toBeNull();
  });

  it('an address, a trust or a placeholder is not a name', () => {
    for (const junk of ['123 Oak St', '12 Oak St Dr,', 'Smith Family Trust', 'Smith Trust', 'Estate of', 'Owner', 'Unknown', 'Current Resident', 'Acme LLC', 'Jane 2']) {
      expect(spokenFirstName(junk)).toBeNull();
    }
  });

  it('an initial alone is not a name; empty is null', () => {
    for (const none of ['J', 'J.', 'j', '', '   ', null, undefined]) expect(spokenFirstName(none)).toBeNull();
  });

  it('three or more words: only the first', () => {
    expect(spokenFirstName('Mary Ann Lee')).toBe('Mary');
  });

  it('a middle or leading initial is left out', () => {
    expect(spokenFirstName('John M')).toBe('John');
    expect(spokenFirstName('John M.')).toBe('John');
    expect(spokenFirstName('J. Robert')).toBe('Robert');
    expect(spokenFirstName('mary a')).toBe('Mary');
  });

  it('a title is said with a name, never alone', () => {
    expect(spokenFirstName('Dr. Patel')).toBe('Dr. Patel');
    expect(spokenFirstName('Mr. John Smith')).toBe('Mr. Smith');
    expect(spokenFirstName('Mrs.')).toBeNull();
  });

  it('all capitals or all lower case is said as a name', () => {
    expect(spokenFirstName('JAMES')).toBe('James');
    expect(spokenFirstName('mary ann')).toBe('Mary Ann');
    expect(spokenFirstName('JEAN-LUC')).toBe('Jean-Luc');
    expect(spokenFirstName('McKenzie')).toBe('McKenzie');
  });
});
