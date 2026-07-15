import { describe, expect, it } from 'vitest';
import { mapAnsweredBy } from './amd.js';

describe('mapAnsweredBy', () => {
  it('humans + unknown bridge; machines/fax skip', () => {
    for (const h of ['human', 'unknown', undefined, '']) expect(mapAnsweredBy(h)).toBe('connected');
    for (const m of ['machine_start', 'machine_end_beep', 'machine_end_silence', 'fax']) expect(mapAnsweredBy(m)).toBe('no_connect');
  });
});
