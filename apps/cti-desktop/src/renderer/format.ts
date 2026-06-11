/**
 * Display formatting helpers. Pure presentation — the raw dial string
 * (digits, +, *, #) stays in state untouched; these only shape what the
 * rep sees.
 */

/**
 * Progressive as-you-type formatter for NANP numbers.
 *   "619"          → "619"
 *   "6198481"      → "619-8481"
 *   "6198481782"   → "(619) 848-1782"
 *   "16198481782"  → "+1 (619) 848-1782"
 *   "+16198481782" → "+1 (619) 848-1782"
 * Keypad codes (* / #) and non-NANP international input pass through verbatim.
 */
export function formatDialString(raw: string): string {
  if (!raw) return '';
  if (/[*#]/.test(raw)) return raw;
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (hasPlus && !digits.startsWith('1')) return raw; // non-NANP international
  const nanp = digits.startsWith('1') && (hasPlus || digits.length > 10)
    ? digits.slice(1)
    : digits;
  const prefix = digits.startsWith('1') && (hasPlus || digits.length > 10) ? '+1 ' : '';
  if (nanp.length > 10) return raw; // overflow: show exactly what was typed
  if (nanp.length === 0) return prefix.trim();
  if (nanp.length <= 3) return `${prefix}${nanp}`;
  if (nanp.length <= 7) return `${prefix}${nanp.slice(0, 3)}-${nanp.slice(3)}`;
  return `${prefix}(${nanp.slice(0, 3)}) ${nanp.slice(3, 6)}-${nanp.slice(6)}`;
}

/** "+16198481782" → "+1 (619) 848-1782"; non-NANP E.164 returned untouched. */
export function formatE164(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
}

/** Seconds → "m:ss" (or "—" when empty). */
export function formatDuration(secs: number | null | undefined): string {
  if (secs == null || secs === 0) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** ISO timestamp → compact relative time ("4m ago"). */
export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}
