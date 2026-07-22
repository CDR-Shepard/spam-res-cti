import { describe, expect, it } from 'vitest';
import { parseListViews, parseListViewResultIds } from './listviews.js';

describe('parseListViews', () => {
  it('extracts id/label/developerName and sorts by label', () => {
    const json = {
      listviews: [
        { id: '00B2', label: 'Zeta Opps', developerName: 'Zeta_Opps' },
        { id: '00B1', label: 'Alpha Opps', developerName: 'Alpha_Opps' },
      ],
      done: true,
    };
    expect(parseListViews(json)).toEqual([
      { id: '00B1', label: 'Alpha Opps', developerName: 'Alpha_Opps' },
      { id: '00B2', label: 'Zeta Opps', developerName: 'Zeta_Opps' },
    ]);
  });

  it('is empty/robust for missing or malformed input', () => {
    expect(parseListViews(null)).toEqual([]);
    expect(parseListViews({})).toEqual([]);
    expect(parseListViews({ listviews: [{ id: '00B1' }] })).toEqual([]); // no label → dropped
  });
});

describe('parseListViewResultIds', () => {
  it('pulls the Id column value from each record (real results shape)', () => {
    const json = {
      records: [
        { columns: [{ fieldNameOrPath: 'Name', value: 'A' }, { fieldNameOrPath: 'Id', value: '006US00000DyV4hYAF' }] },
        { columns: [{ fieldNameOrPath: 'Name', value: 'B' }, { fieldNameOrPath: 'Id', value: '006US00000Zzzz1YAF' }] },
      ],
      done: true,
    };
    expect(parseListViewResultIds(json)).toEqual(['006US00000DyV4hYAF', '006US00000Zzzz1YAF']);
  });

  it('skips records with no Id column and is robust for malformed input', () => {
    expect(parseListViewResultIds(null)).toEqual([]);
    expect(parseListViewResultIds({ records: [{ columns: [{ fieldNameOrPath: 'Name', value: 'A' }] }] })).toEqual([]);
    expect(parseListViewResultIds({ records: [{}] })).toEqual([]);
  });
});
