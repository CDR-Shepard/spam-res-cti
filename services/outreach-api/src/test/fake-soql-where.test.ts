import { describe, expect, it } from 'vitest';
import { rowsWhere } from './fake-soql-where.js';

const table = [
  { Id: 'a', OwnerId: '005A', IsAllDayEvent: false },
  { Id: 'b', OwnerId: '005B', IsAllDayEvent: true },
  { Id: 'c', OwnerId: '005C', IsAllDayEvent: false },
];
const ids = (soql: string): unknown[] => rowsWhere(soql, table).map((r) => r.Id);

describe('rowsWhere: Field IN (…)', () => {
  it('keeps the rows whose field equals any listed literal', () => {
    expect(ids("SELECT Id FROM Event WHERE OwnerId IN ('005A', '005C')")).toEqual(['a', 'c']);
    expect(ids("SELECT Id FROM Event WHERE OwnerId IN ('005B')")).toEqual(['b']);
  });

  it('combines with AND, OR and parentheses', () => {
    expect(ids("SELECT Id FROM Event WHERE OwnerId IN ('005A','005B') AND IsAllDayEvent = false")).toEqual(['a']);
    expect(ids("SELECT Id FROM Event WHERE (OwnerId IN ('005A') OR OwnerId IN ('005C')) AND IsAllDayEvent = false ORDER BY Id")).toEqual(['a', 'c']);
  });

  it('a field the row does not carry is true, as for the other operators', () => {
    expect(ids("SELECT Id FROM Event WHERE WhoId IN ('00Q1')")).toEqual(['a', 'b', 'c']);
  });

  it('a list it cannot read throws', () => {
    expect(() => ids("SELECT Id FROM Event WHERE OwnerId IN '005A'")).toThrow(/fake SOQL/);
    expect(() => ids("SELECT Id FROM Event WHERE OwnerId IN ('005A' '005B')")).toThrow(/fake SOQL/);
    expect(() => ids("SELECT Id FROM Event WHERE OwnerId IN ('005A',")).toThrow(/fake SOQL/);
  });
});
