import { describe, expect, it, vi } from 'vitest';

// The REAL schema the route parses with — imported, never mirrored (see
// routes/dialer.test.ts for the same rule).
import { PatchMeBody, ensurePermissionSetOnConnect } from './auth.js';

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

/**
 * The Salesforce OAuth callback grants the CTI permission set to a rep who has
 * just connected. That route is unauthenticated and has no test harness, so the
 * gate, the org it passes, and its throw-safety are pinned here on the extracted
 * helper instead. Deleting the hook entirely used to pass the whole suite.
 */
describe('ensurePermissionSetOnConnect', () => {
  const enabled = { orgId: 'org-1', powerDialerEnabled: true };

  it('grants the permission set for a rep who is switched on', async () => {
    const ensure = vi.fn(async () => ({ status: 'assigned' }));
    const out = await ensurePermissionSetOnConnect(
      { findUser: async () => enabled, ensure },
      'user-1',
    );
    expect(ensure).toHaveBeenCalledWith({ orgId: 'org-1', targetUserId: 'user-1' });
    expect(out).toEqual({ status: 'assigned' });
  });

  // A rep who is not on the dialer writes no Tasks through the CTI, so there is
  // nothing for the marker field to be useful on yet.
  it('does nothing for a rep who is not switched on', async () => {
    const ensure = vi.fn(async () => ({ status: 'assigned' }));
    const out = await ensurePermissionSetOnConnect(
      { findUser: async () => ({ orgId: 'org-1', powerDialerEnabled: false }), ensure },
      'user-1',
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('does nothing when the user cannot be found', async () => {
    const ensure = vi.fn(async () => ({ status: 'assigned' }));
    const out = await ensurePermissionSetOnConnect(
      { findUser: async () => undefined, ensure },
      'user-1',
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  // It passes the TARGET's own org, never a caller-supplied one — this is what
  // stops one tenant's admin token from acting in another tenant.
  it("passes the target's own org, not anything from the request", async () => {
    const ensure = vi.fn(async () => ({ status: 'assigned' }));
    await ensurePermissionSetOnConnect(
      { findUser: async () => ({ orgId: 'org-OTHER', powerDialerEnabled: true }), ensure },
      'user-1',
    );
    expect(ensure).toHaveBeenCalledWith({ orgId: 'org-OTHER', targetUserId: 'user-1' });
  });

  // This runs inside the OAuth callback's try block. If it rejected, a database
  // blip would render "Salesforce connection failed" over a sign-in that worked.
  it('resolves rather than rejecting when the user lookup throws', async () => {
    const out = await ensurePermissionSetOnConnect(
      {
        findUser: async () => {
          throw new Error('pool exhausted');
        },
        ensure: async () => ({ status: 'assigned' }),
      },
      'user-1',
    );
    expect(out).toBeNull();
  });

  it('resolves rather than rejecting when the grant itself throws', async () => {
    const out = await ensurePermissionSetOnConnect(
      {
        findUser: async () => enabled,
        ensure: async () => {
          throw new Error('salesforce down');
        },
      },
      'user-1',
    );
    expect(out).toBeNull();
  });
});
