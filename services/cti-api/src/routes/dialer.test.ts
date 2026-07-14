import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// The POST /dialer/sessions body schema, mirrored for a pure validation test.
const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity']),
  recordIds: z.array(z.string().min(15).max(20)).min(1).max(500),
});

describe('POST /dialer/sessions body validation', () => {
  it('accepts a Lead/Opp list of SF ids and rejects junk', () => {
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Account', recordIds: ['x'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: [] }).success).toBe(false);
  });
});
