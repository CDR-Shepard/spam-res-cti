/**
 * The little XML the SOAP API needs: escaping what we send, and reading the
 * known, flat shapes Salesforce answers with. Not a general XML parser: no new
 * dependency for a handful of elements.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes the five XML special characters, so any value is safe inside an element or attribute. */
export function xmlEscape(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Un-escapes the five named entities and numeric character references (`&amp;` last). */
export function xmlUnescape(v: string): string {
  return v
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
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
