/**
 * The little XML the SOAP API needs: escaping what we send, and reading the
 * known, flat shapes Salesforce answers with. Not a general XML parser: no new
 * dependency for a handful of elements.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Characters XML 1.0 forbids (D-5): C0 controls other than tab, LF and CR, U+FFFE and U+FFFF, and a surrogate that is not
 * half of a pair. Sent as-is they make Salesforce fault the whole envelope (`soapenv:Client`), so they are dropped.
 */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escapes the five XML special characters and drops characters XML 1.0 forbids, so any value is safe inside an element or attribute. */
export function xmlEscape(v: string): string {
  return v.replace(XML_ILLEGAL, '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A numeric character reference's character; one that is out of range or a surrogate reads as U+FFFD, never a throw (D-5). */
function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
}

/** Un-escapes the five named entities and numeric character references (`&amp;` last). Never throws. */
export function xmlUnescape(v: string): string {
  return v
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_m, dec: string) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const PREFIX = '(?:[A-Za-z_][\\w.-]*:)?';

/**
 * The raw inner text of every element whose local name is `name`, whatever its
 * namespace prefix. A self-closing element (`<accountId xsi:nil="true"/>`) gives ''.
 * Elements of the same name must not nest (true of every shape read here).
 */
export function elements(xml: string, name: string): string[] {
  const re = new RegExp(`<${PREFIX}${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${PREFIX}${name}\\s*>)`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/** The un-escaped, trimmed text of the first `name` element, or null when absent or empty. */
export function text(xml: string, name: string): string | null {
  const first = elements(xml, name)[0];
  if (first === undefined) return null;
  const v = xmlUnescape(first).trim();
  return v === '' ? null : v;
}

/** `{ code, message }` of a SOAP fault, the code without its namespace prefix (`sf:X` → `X`); null when not a fault. */
export function soapFault(xml: string): { code: string; message: string } | null {
  const fault = elements(xml, 'Fault')[0];
  if (fault === undefined) return null;
  const code = (text(fault, 'faultcode') ?? 'UNKNOWN_FAULT').replace(/^[^:]*:/, '');
  return { code, message: text(fault, 'faultstring') ?? code };
}
