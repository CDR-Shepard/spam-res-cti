import { describe, expect, it } from 'vitest';
import { isPlainText } from './plain-text.js';

describe('isPlainText', () => {
  it.each([
    ['ordinary text with newlines and tabs', 'Line one\n\tLine two', true],
    ['an emoji pair', 'Great call 👍', true],
    ['numbers and null', { n: 1, x: null }, true],
    ['a NUL', 'bad\u0000text', false],
    ['an escape character', 'bad\u001b[31m', false],
    ['a lone high surrogate', 'cut\ud83d', false],
    ['a lone low surrogate', '\ude00cut', false],
    ['a bad string nested in an array of objects', { a: [{ b: 'x\u0007' }] }, false],
    ['a bad object key', { 'k\u0000': 'v' }, false],
  ])('%s', (_name, value, expected) => {
    expect(isPlainText(value)).toBe(expected);
  });
});
