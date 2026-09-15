import { describe, expect, it, vi } from 'vitest';
import {
  CTI_PERMISSION_SET_NAME,
  ensureCtiPermissionSet,
  ensureCtiPermissionSetForUser,
  isDuplicateAssignment,
  MAX_ADMIN_ATTEMPTS,
  PERMISSION_SET_MISSING,
  type PermissionSetDeps,
  type PermissionSetLookup,
} from './permission-set.js';

const PS_ID = '0PS000000000001';
const TARGET_SF = '0051234567890AB';

/** soqlQuery fake: first call answers the PermissionSet lookup, second the assignment lookup. */
function deps(over: Partial<PermissionSetDeps> = {}): PermissionSetDeps {
  return {
    soqlQuery: vi.fn(async (_u: string, soql: string) =>
      /FROM PermissionSet\b/.test(soql) ? [{ Id: PS_ID }] : [],
    ) as unknown as PermissionSetDeps['soqlQuery'],
    sfFetch: vi.fn(async () => ({ status: 201, json: { id: '0Pa1', success: true } })),
    ...over,
  };
}

describe('ensureCtiPermissionSet', () => {
  it('creates the assignment as the ADMIN, never as the target', async () => {
    const d = deps();
    const out = await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);

    expect(out).toEqual({ status: 'assigned' });
    const [userId, path, init] = (d.sfFetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(userId).toBe('admin-user');
    expect(path).toBe('/sobjects/PermissionSetAssignment');
    expect(init).toMatchObject({
      method: 'POST',
      body: { PermissionSetId: PS_ID, AssigneeId: TARGET_SF },
    });
  });

  it('does not POST when the rep already has it', async () => {
    const d = deps({
      soqlQuery: vi.fn(async (_u: string, soql: string) =>
        /FROM PermissionSet\b/.test(soql) ? [{ Id: PS_ID }] : [{ Id: '0Pa9' }],
      ) as unknown as PermissionSetDeps['soqlQuery'],
    });
    expect(await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF)).toEqual({ status: 'already' });
    expect(d.sfFetch).not.toHaveBeenCalled();
  });

  it('skips, without POSTing, when the permission set is not in the org', async () => {
    const d = deps({ soqlQuery: vi.fn(async () => []) as unknown as PermissionSetDeps['soqlQuery'] });
    const out = await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);
    expect(out.status).toBe('skipped');
    expect(out.status === 'skipped' && out.reason).toContain(CTI_PERMISSION_SET_NAME);
    expect(d.sfFetch).not.toHaveBeenCalled();
  });

  // Two admins enabling the same rep at once: the loser must not report failure.
  it('treats DUPLICATE_VALUE as already assigned', async () => {
    const d = deps({
      sfFetch: vi.fn(async () => ({
        status: 400,
        json: [{ errorCode: 'DUPLICATE_VALUE', message: 'duplicate value found' }],
      })),
    });
    expect(await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF)).toEqual({ status: 'already' });
  });

  it('reports a real Salesforce refusal as failed, with the body', async () => {
    const d = deps({
      sfFetch: vi.fn(async () => ({ status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] })),
    });
    const out = await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.reason).toContain('INSUFFICIENT_ACCESS');
  });

  // Nothing here may bring down the operation that triggered it.
  it('never throws when Salesforce is unreachable', async () => {
    const d = deps({
      soqlQuery: vi.fn(async () => {
        throw new Error('socket hang up');
      }) as unknown as PermissionSetDeps['soqlQuery'],
    });
    const out = await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);
    expect(out).toEqual({ status: 'failed', reason: 'socket hang up' });
  });

  it('escapes quotes in the ids it interpolates into SOQL', async () => {
    const d = deps();
    await ensureCtiPermissionSet(d, 'admin-user', "005' OR Id != '");
    const soql = (d.soqlQuery as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string;
    expect(soql).toContain("\\'");
    expect(soql).not.toMatch(/AssigneeId = '005' OR/);
  });
});

function lookup(over: Partial<PermissionSetLookup> = {}): PermissionSetLookup {
  return {
    sfUserIdOf: vi.fn(async () => TARGET_SF),
    adminsWithConnection: vi.fn(async () => ['admin-a', 'admin-b']),
    ...over,
  };
}

describe('ensureCtiPermissionSetForUser', () => {
  it('skips when the rep has never connected Salesforce', async () => {
    const d = { ...deps(), ...lookup({ sfUserIdOf: vi.fn(async () => null) }) };
    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });
    expect(out.status).toBe('skipped');
    expect(out.status === 'skipped' && out.reason).toMatch(/no Salesforce connection/);
    expect(d.sfFetch).not.toHaveBeenCalled();
  });

  it('skips when no admin in the org has connected Salesforce', async () => {
    const d = { ...deps(), ...lookup({ adminsWithConnection: vi.fn(async () => []) }) };
    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });
    expect(out.status).toBe('skipped');
    expect(out.status === 'skipped' && out.reason).toMatch(/no admin/);
    expect(d.sfFetch).not.toHaveBeenCalled();
  });

  it('acts as the triggering admin first when they have a connection', async () => {
    const d = { ...deps(), ...lookup() };
    await ensureCtiPermissionSetForUser(d, {
      orgId: 'o1',
      targetUserId: 'u1',
      preferredAdminUserId: 'admin-b',
    });
    expect((d.sfFetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('admin-b');
  });

  // Being a CTI admin does not mean they connected Salesforce.
  it('ignores a preferred admin who has no connection', async () => {
    const d = { ...deps(), ...lookup() };
    await ensureCtiPermissionSetForUser(d, {
      orgId: 'o1',
      targetUserId: 'u1',
      preferredAdminUserId: 'admin-zzz',
    });
    expect((d.sfFetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('admin-a');
  });

  it('falls through to the next admin when the first lacks the Salesforce permission', async () => {
    const sfFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] })
      .mockResolvedValueOnce({ status: 201, json: { id: '0Pa1' } });
    const d = { ...deps({ sfFetch }), ...lookup() };

    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });

    expect(out).toEqual({ status: 'assigned' });
    expect(sfFetch.mock.calls.map((c) => c[0])).toEqual(['admin-a', 'admin-b']);
  });

  it('returns the last failure when every admin is refused', async () => {
    const sfFetch = vi.fn(async () => ({ status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] }));
    const d = { ...deps({ sfFetch }), ...lookup() };
    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });
    expect(out.status).toBe('failed');
    expect(sfFetch).toHaveBeenCalledTimes(2);
  });

  it('stops at the first success instead of assigning twice', async () => {
    const d = { ...deps(), ...lookup() };
    await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });
    expect(d.sfFetch).toHaveBeenCalledTimes(1);
  });

  it('never throws when the lookup itself fails', async () => {
    const d = {
      ...deps(),
      ...lookup({
        sfUserIdOf: vi.fn(async () => {
          throw new Error('db down');
        }),
      }),
    };
    expect(await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' })).toEqual({
      status: 'failed',
      reason: 'db down',
    });
  });
});

describe('isDuplicateAssignment', () => {
  it('matches the documented code', () => {
    expect(isDuplicateAssignment([{ errorCode: 'DUPLICATE_VALUE' }])).toBe(true);
  });
  it('matches the message wording as a fallback', () => {
    expect(isDuplicateAssignment([{ errorCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'Duplicate value found' }])).toBe(true);
  });
  it('does not match an access error', () => {
    expect(isDuplicateAssignment([{ errorCode: 'INSUFFICIENT_ACCESS' }])).toBe(false);
  });
  it('tolerates junk bodies', () => {
    expect(isDuplicateAssignment(null)).toBe(false);
    expect(isDuplicateAssignment('nope')).toBe(false);
    expect(isDuplicateAssignment([])).toBe(false);
  });
});

describe('the SOQL text ensureCtiPermissionSet sends', () => {
  it('looks the permission set up by Name, the field PermissionSet actually has', async () => {
    const d = deps();
    await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);
    const first = (d.soqlQuery as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    // DeveloperName does not exist on PermissionSet — that spelling makes every
    // grant fail with a SOQL error, and no fake-DB test would notice.
    expect(first).toMatch(/FROM PermissionSet WHERE Name = '/);
    expect(first).not.toMatch(/DeveloperName/);
  });

  it('asks for the exact permission set the org was given', async () => {
    const d = deps();
    await ensureCtiPermissionSet(d, 'admin-user', TARGET_SF);
    const first = (d.soqlQuery as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(first).toContain("'CTI_Task_Origin'");
  });

  it('escapes a backslash as well as a quote', async () => {
    const d = deps();
    await ensureCtiPermissionSet(d, 'admin-user', "005\\x'y");
    const second = (d.soqlQuery as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string;
    expect(second).toContain("005\\\\x\\'y");
  });
});

describe('the admin walk is bounded', () => {
  it('gives up after MAX_ADMIN_ATTEMPTS rather than one call per admin in the org', async () => {
    const sfFetch = vi.fn(async () => ({ status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] }));
    const many = Array.from({ length: 12 }, (_, i) => `admin-${i}`);
    const d = {
      ...deps({ sfFetch }),
      ...lookup({ adminsWithConnection: vi.fn(async () => many) }),
    };

    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });

    expect(out.status).toBe('failed');
    expect(sfFetch).toHaveBeenCalledTimes(MAX_ADMIN_ATTEMPTS);
  });

  // "Permission set not in org" is the same answer from every admin.
  it('stops immediately when the permission set is missing, instead of asking each admin', async () => {
    const soqlQuery = vi.fn(async () => []) as unknown as PermissionSetDeps['soqlQuery'];
    const d = { ...deps({ soqlQuery }), ...lookup() };

    const out = await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' });

    expect(out).toEqual({ status: 'skipped', reason: PERMISSION_SET_MISSING });
    expect(soqlQuery).toHaveBeenCalledTimes(1);
  });

  // An admin-specific refusal IS worth asking someone else about.
  it('still retries a per-admin refusal with the next admin', async () => {
    const sfFetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, json: [{ errorCode: 'INSUFFICIENT_ACCESS' }] })
      .mockResolvedValueOnce({ status: 201, json: { id: '0Pa1' } });
    const d = { ...deps({ sfFetch }), ...lookup() };
    expect(await ensureCtiPermissionSetForUser(d, { orgId: 'o1', targetUserId: 'u1' })).toEqual({
      status: 'assigned',
    });
  });
});
