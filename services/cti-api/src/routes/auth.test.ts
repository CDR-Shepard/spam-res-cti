import { describe, expect, it, vi } from 'vitest';

// The REAL schema the route parses with — imported, never mirrored (see
// routes/dialer.test.ts for the same rule).
import {
  PatchMeBody,
  assignStarterNumbersOnConnect,
  ensurePermissionSetOnConnect,
  starterNumbersLogLevel,
  starterNumbersOnConnectDeps,
  type StarterNumbersOnConnectDeps,
} from './auth.js';
import type { AutoAssignOutcome } from '../fleet/auto-assign.js';
import { PgDialect } from 'drizzle-orm/pg-core';

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

  it('accepts a hold-music choice, with or without a YouTube link', () => {
    expect(PatchMeBody.safeParse({ holdMusic: { choice: 'ambient' } }).success).toBe(true);
    expect(
      PatchMeBody.safeParse({ holdMusic: { choice: 'youtube', youtubeLink: 'https://youtu.be/dQw4w9WgXcQ' } })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown choice, a choice-less holdMusic object, and an oversized YouTube link', () => {
    expect(PatchMeBody.safeParse({ holdMusic: { choice: 'jazz' } }).success).toBe(false);
    expect(PatchMeBody.safeParse({ holdMusic: {} }).success).toBe(false);
    expect(
      PatchMeBody.safeParse({ holdMusic: { choice: 'youtube', youtubeLink: 'x'.repeat(501) } }).success,
    ).toBe(false);
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
 * Starter numbers on sign-in. The OAuth callback has no route harness, so the
 * gate, the lookup and the throw-safety are pinned on the extracted helper, and
 * the live deps factory is pinned separately so the call site cannot rot.
 */
const ASSIGNED: AutoAssignOutcome = { status: 'assigned', la: [], sd: [], shortLa: 0, shortSd: 0 };

function connectDeps(over: Partial<StarterNumbersOnConnectDeps> = {}): StarterNumbersOnConnectDeps {
  return {
    profileName: async () => 'Sales',
    eligibleProfiles: ['Sales'],
    findUser: async () => ({ orgId: 'org-1', email: 'hudson@sjoinvestments.com' }),
    assign: vi.fn(async () => ASSIGNED),
    ...over,
  };
}

describe('assignStarterNumbersOnConnect', () => {
  it("assigns using the USER ROW's org and email", async () => {
    const d = connectDeps();
    const out = await assignStarterNumbersOnConnect(d, 'user-1');
    expect(d.assign).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', email: 'hudson@sjoinvestments.com' });
    expect(out).toEqual(ASSIGNED);
  });

  // The org is what scopes the reserve. It must come from the row, so a sign-in
  // can never claim another tenant's numbers.
  it("passes the target's own org, whatever it is", async () => {
    const d = connectDeps({ findUser: async () => ({ orgId: 'org-OTHER', email: 'x@y.com' }) });
    await assignStarterNumbersOnConnect(d, 'user-9');
    expect(d.assign).toHaveBeenCalledWith({ orgId: 'org-OTHER', userId: 'user-9', email: 'x@y.com' });
  });

  // Anyone in the Salesforce org can open the app once. Three of them would
  // empty a reserve of a few dozen before the next real hire arrives.
  it('skips a user whose Salesforce profile is not a rep profile, touching nothing', async () => {
    const findUser = vi.fn(async () => ({ orgId: 'org-1', email: 'a@b.com' }));
    const d = connectDeps({ profileName: async () => 'Accounting', findUser });
    const out = await assignStarterNumbersOnConnect(d, 'user-1');
    expect(out?.status).toBe('skipped');
    expect(d.assign).not.toHaveBeenCalled();
    expect(findUser).not.toHaveBeenCalled(); // eligibility is decided BEFORE any DB work
  });

  // Failing closed costs one retry next sign-in; failing open costs numbers.
  it('skips when the profile lookup failed, rather than guessing', async () => {
    const d = connectDeps({ profileName: async () => null });
    expect((await assignStarterNumbersOnConnect(d, 'user-1'))?.status).toBe('skipped');
    expect(d.assign).not.toHaveBeenCalled();
  });

  // "Off" has to mean off: in connect mode the profile lookup is a Salesforce
  // query, and a disabled feature must not spend one per sign-in.
  it('is off entirely when no profile is configured — without even looking the profile up', async () => {
    const profileName = vi.fn(async () => 'Sales');
    const d = connectDeps({ eligibleProfiles: [], profileName });
    expect((await assignStarterNumbersOnConnect(d, 'user-1'))?.status).toBe('skipped');
    expect(profileName).not.toHaveBeenCalled();
    expect(d.assign).not.toHaveBeenCalled();
  });

  it('does nothing when the user cannot be found', async () => {
    const d = connectDeps({ findUser: async () => undefined });
    expect(await assignStarterNumbersOnConnect(d, 'user-1')).toBeNull();
    expect(d.assign).not.toHaveBeenCalled();
  });

  // Inside the OAuth callback a rejection would render "Salesforce connection
  // failed" over a sign-in that had already been committed.
  it.each([
    ['the profile lookup', { profileName: async () => { throw new Error('sf 503'); } }],
    ['the user lookup', { findUser: async () => { throw new Error('pool exhausted'); } }],
    ['the assignment', { assign: async () => { throw new Error('deadlock'); } }],
  ] as Array<[string, Partial<StarterNumbersOnConnectDeps>]>)(
    'resolves rather than rejecting when %s throws',
    async (_label, over) => {
      const out = await assignStarterNumbersOnConnect(connectDeps(over), 'user-1');
      expect(out?.status).toBe('failed');
    },
  );
});

describe('starterNumbersOnConnectDeps — the live wiring', () => {
  // Copying the permission hook's `columns` (orgId + powerDialerEnabled) would
  // leave email undefined; the label code throws; the feature dies behind one
  // warn that looks like any other. Deleting this whole call used to pass 854 tests.
  it('selects exactly the columns the assignment needs', async () => {
    const findFirst = vi.fn(async () => ({ orgId: 'org-1', email: 'a@b.com' }));
    const deps = starterNumbersOnConnectDeps({
      db: { query: { users: { findFirst } } } as never,
      eligibleProfiles: ['Sales'],
      profileName: async () => 'Sales',
    });
    await deps.findUser('user-1');
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect((findFirst.mock.calls[0] as unknown[])[0]).toMatchObject({ columns: { orgId: true, email: true } });
  });

  // The row this returns supplies the orgId that SCOPES the claim. Looking the
  // user up by the wrong column is a tenancy bug, not a cosmetic one.
  it('looks the user up by their ID, and nothing else', async () => {
    const findFirst = vi.fn(async () => ({ orgId: 'org-1', email: 'a@b.com' }));
    const deps = starterNumbersOnConnectDeps({
      db: { query: { users: { findFirst } } } as never,
      eligibleProfiles: ['Sales'],
      profileName: async () => 'Sales',
    });
    await deps.findUser('user-42');
    const where = (findFirst.mock.calls[0] as unknown as Array<{ where: unknown }>)[0]!.where;
    const rendered = new PgDialect().sqlToQuery(where as never);
    expect(rendered.sql.replace(/\s+/g, ' ')).toBe('"users"."id" = $1');
    expect(rendered.params).toEqual(['user-42']);
  });

  it('passes the eligibility settings straight through', () => {
    const profileName = async () => 'Sales';
    const deps = starterNumbersOnConnectDeps({ db: {} as never, eligibleProfiles: ['Sales', 'Wholesale'], profileName });
    expect(deps.eligibleProfiles).toEqual(['Sales', 'Wholesale']);
    expect(deps.profileName).toBe(profileName);
  });
});

describe('starterNumbersLogLevel', () => {
  it('says nothing for "already equipped" — nearly every sign-in', () => {
    expect(starterNumbersLogLevel({ status: 'already' })).toBeNull();
    expect(starterNumbersLogLevel(null)).toBeNull();
  });

  // A wrong STARTER_NUMBER_PROFILES makes the whole feature a silent no-op. The
  // skip line is the only trace that explains "the new hire has no numbers".
  it('logs a skip, so a misconfigured profile name is visible', () => {
    expect(starterNumbersLogLevel({ status: 'skipped', reason: 'x' })).toBe('info');
  });

  it('is an info for a clean assignment', () => {
    expect(starterNumbersLogLevel(ASSIGNED)).toBe('info');
  });

  // A dry reserve is the one outcome someone has to ACT on: buy more.
  it('is a warn when the reserve came up short, on either side', () => {
    expect(starterNumbersLogLevel({ ...ASSIGNED, shortLa: 1 })).toBe('warn');
    expect(starterNumbersLogLevel({ ...ASSIGNED, shortSd: 6 })).toBe('warn');
  });

  it('is a warn on failure', () => {
    expect(starterNumbersLogLevel({ status: 'failed', reason: 'x' })).toBe('warn');
  });
});
