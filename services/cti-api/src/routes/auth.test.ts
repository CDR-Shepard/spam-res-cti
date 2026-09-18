import { describe, expect, it, vi } from 'vitest';

// The REAL schema the route parses with — imported, never mirrored (see
// routes/dialer.test.ts for the same rule).
import { PatchMeBody, assignStarterNumbersOnConnect, ensurePermissionSetOnConnect } from './auth.js';

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

/**
 * Starter numbers on first sign-in. Same reasoning as the permission-set hook:
 * the OAuth callback has no route harness, so the lookup and the throw-safety
 * are pinned on the extracted helper.
 */
describe('assignStarterNumbersOnConnect', () => {
  const user = { orgId: 'org-1', email: 'hudson@sjoinvestments.com' };

  it("assigns using the USER ROW's org and email", async () => {
    const assign = vi.fn(async () => ({ status: 'assigned' }));
    const out = await assignStarterNumbersOnConnect({ findUser: async () => user, assign }, 'user-1');
    expect(assign).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', email: 'hudson@sjoinvestments.com' });
    expect(out).toEqual({ status: 'assigned' });
  });

  // Unlike the permission-set hook, numbers do NOT wait for the power dialer:
  // the softphone needs something to dial from for manual calls too.
  it('does not depend on the power-dialer flag', async () => {
    const assign = vi.fn(async () => ({ status: 'assigned' }));
    await assignStarterNumbersOnConnect(
      { findUser: async () => ({ ...user, powerDialerEnabled: false }) as typeof user, assign },
      'user-1',
    );
    expect(assign).toHaveBeenCalledTimes(1);
  });

  // The org is what scopes the reserve. It must come from the row, so a sign-in
  // can never claim another tenant's numbers.
  it("passes the target's own org, whatever it is", async () => {
    const assign = vi.fn(async () => ({ status: 'assigned' }));
    await assignStarterNumbersOnConnect(
      { findUser: async () => ({ orgId: 'org-OTHER', email: 'x@y.com' }), assign },
      'user-9',
    );
    expect(assign).toHaveBeenCalledWith({ orgId: 'org-OTHER', userId: 'user-9', email: 'x@y.com' });
  });

  it('does nothing when the user cannot be found', async () => {
    const assign = vi.fn(async () => ({ status: 'assigned' }));
    expect(await assignStarterNumbersOnConnect({ findUser: async () => undefined, assign }, 'user-1')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  // Inside the OAuth callback's try block a rejection would render "Salesforce
  // connection failed" over a sign-in that had already been committed.
  it('resolves rather than rejecting when the lookup throws', async () => {
    const out = await assignStarterNumbersOnConnect(
      { findUser: async () => { throw new Error('pool exhausted'); }, assign: async () => ({}) },
      'user-1',
    );
    expect(out).toBeNull();
  });

  it('resolves rather than rejecting when the assignment throws', async () => {
    const out = await assignStarterNumbersOnConnect(
      { findUser: async () => user, assign: async () => { throw new Error('deadlock'); } },
      'user-1',
    );
    expect(out).toBeNull();
  });
});
