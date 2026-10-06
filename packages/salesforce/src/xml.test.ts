/** D-5: what we send is always legal XML 1.0, and nothing Salesforce sends back can make the reader throw. */
import { describe, expect, it } from 'vitest';
import { isPermanentSoapFault } from './convert-lead.js';
import { xmlEscape, xmlUnescape } from './xml.js';

describe('xmlEscape', () => {
  it('escapes the five special characters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('strips characters XML 1.0 forbids (C0 controls but tab, CR and LF; U+FFFE, U+FFFF; lone surrogates)', () => {
    expect(xmlEscape('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u001Fg')).toBe('abcdefg');
    expect(xmlEscape('tab\there\r\nnext')).toBe('tab\there\r\nnext');
    expect(xmlEscape('x￾y￿z')).toBe('xyz');
    expect(xmlEscape('lone \uD800 high, lone \uDC00 low')).toBe('lone  high, lone  low');
  });

  it('keeps real surrogate pairs (emoji) and ordinary non-ASCII text', () => {
    expect(xmlEscape('José 🏠 ok')).toBe('José 🏠 ok');
  });
});

describe('xmlUnescape', () => {
  it('reads named and numeric references', () => {
    expect(xmlUnescape('&lt;a&gt; &amp;amp; &#65;&#x42; &quot;&apos;')).toBe(`<a> &amp; AB "'`);
  });

  it('never throws on an out-of-range or illegal numeric reference: it becomes U+FFFD', () => {
    expect(xmlUnescape('a&#x110000;b')).toBe('a�b');
    expect(xmlUnescape('a&#9999999;b')).toBe('a�b');
    expect(xmlUnescape('a&#xD800;b')).toBe('a�b');
  });
});

describe('isPermanentSoapFault (D-5)', () => {
  it.each([
    'INSUFFICIENT_ACCESS',
    'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
    'INSUFFICIENT_ACCESS_OR_READONLY',
    'API_DISABLED_FOR_ORG',
    'API_CURRENTLY_DISABLED',
    'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    'CANNOT_UPDATE_CONVERTED_LEAD',
    'INVALID_CROSS_REFERENCE_KEY',
    'INVALID_STATUS',
    'Client',
  ])('%s is permanent', (code) => {
    expect(isPermanentSoapFault(code)).toBe(true);
  });

  it.each(['UNABLE_TO_LOCK_ROW', 'REQUEST_LIMIT_EXCEEDED', 'UNKNOWN_EXCEPTION', 'SERVER_UNAVAILABLE', 'INVALID_SESSION_ID', 'Server', ''])(
    '%s is not permanent (retried)',
    (code) => {
      expect(isPermanentSoapFault(code)).toBe(false);
    },
  );
});
