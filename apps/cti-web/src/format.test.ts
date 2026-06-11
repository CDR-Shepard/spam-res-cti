import { describe, expect, it } from 'vitest';
import { formatDialString, formatDuration, formatE164 } from './format';

describe('formatDialString', () => {
  it('formats progressively as the rep types', () => {
    expect(formatDialString('')).toBe('');
    expect(formatDialString('6')).toBe('6');
    expect(formatDialString('619')).toBe('619');
    expect(formatDialString('6198')).toBe('619-8');
    expect(formatDialString('6198481')).toBe('619-8481');
    expect(formatDialString('61984817')).toBe('(619) 848-17');
    expect(formatDialString('6198481782')).toBe('(619) 848-1782');
  });

  it('handles the +1 country code', () => {
    expect(formatDialString('+16198481782')).toBe('+1 (619) 848-1782');
    expect(formatDialString('16198481782')).toBe('+1 (619) 848-1782');
    expect(formatDialString('+1619848')).toBe('+1 619-848');
  });

  it('passes keypad codes and non-NANP international through verbatim', () => {
    expect(formatDialString('*67')).toBe('*67');
    expect(formatDialString('#31#')).toBe('#31#');
    expect(formatDialString('+442071234567')).toBe('+442071234567');
  });

  it('shows overflow input exactly as typed', () => {
    expect(formatDialString('61984817829999')).toBe('61984817829999');
  });
});

describe('formatE164', () => {
  it('formats NANP E.164 for display', () => {
    expect(formatE164('+16198481782')).toBe('+1 (619) 848-1782');
  });
  it('leaves non-NANP and empty values alone', () => {
    expect(formatE164('+442071234567')).toBe('+442071234567');
    expect(formatE164(null)).toBe('');
    expect(formatE164(undefined)).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders m:ss with an em dash for empty', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(7)).toBe('0:07');
    expect(formatDuration(125)).toBe('2:05');
  });
});
