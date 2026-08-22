import { describe, expect, it } from 'vitest';
import { parseSoqlCount } from './client.js';

describe('parseSoqlCount', () => {
  it('reads totalSize — COUNT() queries return no records', () => {
    expect(parseSoqlCount(200, { totalSize: 42, done: true, records: [] })).toBe(42);
  });
  it('is 0 when totalSize is absent', () => {
    expect(parseSoqlCount(200, { done: true, records: [] })).toBe(0);
    expect(parseSoqlCount(200, null)).toBe(0);
  });
  it('throws on a 4xx/5xx with the status in the message', () => {
    expect(() => parseSoqlCount(400, [{ message: 'bad' }])).toThrow(/SOQL count failed \(400\)/);
    expect(() => parseSoqlCount(503, null)).toThrow(/503/);
  });
});
