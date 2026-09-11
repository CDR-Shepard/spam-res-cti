import { describe, expect, it } from 'vitest';

// The REAL schema the route parses with — imported, never mirrored (see
// routes/dialer.test.ts for the same rule).
import { PatchMeBody } from './auth.js';

describe('PATCH /auth/me body', () => {
  it('accepts the forwarding number, the hold-music preference, or both', () => {
    expect(PatchMeBody.safeParse({ noAnswerForwardE164: '+16195550100' }).success).toBe(true);
    expect(PatchMeBody.safeParse({ noAnswerForwardE164: null }).success).toBe(true);
    expect(PatchMeBody.safeParse({ dialerHoldMusic: false }).success).toBe(true);
    expect(PatchMeBody.safeParse({ noAnswerForwardE164: null, dialerHoldMusic: true }).success).toBe(true);
  });

  it('rejects an empty body and a non-boolean preference', () => {
    expect(PatchMeBody.safeParse({}).success).toBe(false);
    expect(PatchMeBody.safeParse({ dialerHoldMusic: 'no' }).success).toBe(false);
    expect(PatchMeBody.safeParse({ dialerHoldMusic: null }).success).toBe(false);
  });
});
