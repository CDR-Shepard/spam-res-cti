import libphonenumber from 'google-libphonenumber';

const PNF = libphonenumber.PhoneNumberFormat;
const util = libphonenumber.PhoneNumberUtil.getInstance();

export interface NormalizedPhone {
  e164: string;
  country: string;
  national: string;
}

export interface NormalizeResult {
  ok: boolean;
  value?: NormalizedPhone;
  error?: string;
}

/**
 * Parse user-entered numbers into E.164 with a default region (US for MVP).
 * Accepts arbitrary spacing, dashes, parens, leading "+".
 */
export function normalize(raw: string, defaultRegion = 'US'): NormalizeResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'Empty number' };
  }
  const trimmed = raw.trim();
  if (!/[0-9]/.test(trimmed)) {
    return { ok: false, error: 'No digits found' };
  }
  try {
    const parsed = util.parse(trimmed, defaultRegion);
    if (!util.isValidNumber(parsed)) {
      return { ok: false, error: 'Invalid number' };
    }
    const region = util.getRegionCodeForNumber(parsed) ?? defaultRegion;
    return {
      ok: true,
      value: {
        e164: util.format(parsed, PNF.E164),
        country: region,
        national: util.format(parsed, PNF.NATIONAL),
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Convenience: returns the E.164 string or null. */
export function toE164(raw: string, defaultRegion = 'US'): string | null {
  const r = normalize(raw, defaultRegion);
  return r.ok ? r.value!.e164 : null;
}
