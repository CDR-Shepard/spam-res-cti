import { describe, expect, it } from 'vitest';
import { soqlEscape } from './client.js';

describe('soqlEscape', () => {
  it("escapes single quotes and backslashes", () => {
    expect(soqlEscape("O'Brien")).toBe("O\\'Brien");
    expect(soqlEscape('a\\b')).toBe('a\\\\b');
    expect(soqlEscape('00Q123')).toBe('00Q123');
  });
});
