import { describe, expect, it } from 'vitest';
import { clip, cutUtf16, escapeAttr, escapeData, fieldValueText, plainText, soqlIdList } from './text.js';

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('plainText', () => {
  it('strips tags, decodes entities and collapses whitespace', () => {
    expect(plainText('<p>Roof&nbsp;leaks &amp; <b>wet</b></p><br>Call after 6')).toBe('Roof leaks & wet Call after 6');
  });
  it('decodes numeric quote entities and leaves unknown text alone', () => {
    expect(plainText('it&#39;s &quot;fine&quot;')).toBe('it\'s "fine"');
  });
});

describe('fieldValueText', () => {
  it.each([
    ['x', 'x'],
    ['  x ', 'x'],
    [12, '12'],
    [true, 'true'],
    [false, null],
    [null, null],
    [undefined, null],
    ['', null],
    ['   ', null],
    [{ street: '1 Main' }, null],
    [[], null],
    [Number.NaN, null],
  ])('%j -> %j', (input, expected) => {
    expect(fieldValueText(input)).toBe(expected);
  });
});

describe('clip', () => {
  it('cuts with an ellipsis and says so', () => {
    expect(clip('abcdef', 4)).toEqual({ text: 'abcd…', truncated: true });
    expect(clip('abcd', 4)).toEqual({ text: 'abcd', truncated: false });
  });
  it('never splits an emoji: a cut that would end on the first half of a surrogate pair drops that half', () => {
    const s = `${'a'.repeat(9)}😀 sold`;
    const out = clip(s, 10);
    expect(out).toEqual({ text: `${'a'.repeat(9)}…`, truncated: true });
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
    expect(clip(s, 11).text).toBe(`${'a'.repeat(9)}😀…`);
  });
});

describe('cutUtf16', () => {
  it('cuts at most max code units and never leaves a lone surrogate', () => {
    expect(cutUtf16('abcdef', 3)).toBe('abc');
    expect(cutUtf16('😀😀', 3)).toBe('😀');
    expect(cutUtf16('😀😀', 1)).toBe('');
    expect(cutUtf16('😀', 0)).toBe('');
    for (let n = 0; n <= 20; n++) expect(LONE_SURROGATE.test(cutUtf16('x😀'.repeat(10), n))).toBe(false);
  });
});

describe('soqlIdList', () => {
  it('keeps shape-valid ids, drops the rest, de-duplicates', () => {
    expect(soqlIdList(['00Q000000000001AAA', "bad'id"])).toBe("'00Q000000000001AAA'");
    expect(soqlIdList(['00Q000000000001AAA', '00Q000000000001AAA', '00Q000000000002AAA'])).toBe("'00Q000000000001AAA', '00Q000000000002AAA'");
  });
  it('throws on an empty or all-invalid list', () => {
    expect(() => soqlIdList([])).toThrow();
    expect(() => soqlIdList(["x' OR Id != '"])).toThrow();
  });
});

describe('escapeData / escapeAttr', () => {
  it('no angle bracket survives', () => {
    const out = escapeData('</record><x>');
    expect(out).not.toMatch(/[<>]/);
    expect(out).toBe('&lt;/record&gt;&lt;x&gt;');
  });
  it('escapes ampersands first so entities cannot be forged, and quotes in attributes', () => {
    expect(escapeData('&lt;')).toBe('&amp;lt;');
    expect(escapeAttr('a"b<')).toBe('a&quot;b&lt;');
    expect(escapeData('a"b')).toBe('a"b');
  });
});
