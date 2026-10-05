import { describe, expect, it } from 'vitest';
import type { RequestContext } from './scope.js';
import { mayDecideWith, sameSfId, SF_ID_CORE } from './record-owner.js';

const ctxOf = (role: 'admin' | 'super' | 'rep'): RequestContext =>
  ({ session: { isAdmin: role === 'admin', isSuperAdmin: role === 'super', userId: 'u1' }, orgId: 'o1', tenant: {} }) as unknown as RequestContext;

const OWNER_15 = '005000000000001';
const OWNER_18 = '005000000000001AAA';
const OTHER_18 = '005000000000002AAA';

describe('mayDecideWith', () => {
  it.each([
    ['admin, no connection, unowned record', 'admin', null, null, true],
    ['super admin, any owner', 'super', null, '005000000000009AAA', true],
    ['rep, 15-character own id against an 18-character owner', 'rep', OWNER_15, OWNER_18, true],
    ['rep, another owner', 'rep', OWNER_18, OTHER_18, false],
    ['rep, no Salesforce connection', 'rep', null, OWNER_18, false],
    ['rep, record without an owner', 'rep', OWNER_18, null, false],
  ] as const)('%s', (_name, role, mine, owner, expected) => {
    expect(mayDecideWith(ctxOf(role), mine, owner)).toBe(expected);
  });
});

describe('sameSfId', () => {
  it('compares the case-sensitive 15-character core', () => {
    expect(SF_ID_CORE).toBe(15);
    expect(sameSfId(OWNER_15, OWNER_15)).toBe(true);
    expect(sameSfId(OWNER_15, OWNER_18)).toBe(true);
    expect(sameSfId('005a00000000001', '005A00000000001')).toBe(false);
  });

  it('is false for a value shorter than 15 characters, or a missing one', () => {
    expect(sameSfId('00500000000001', '00500000000001')).toBe(false);
    expect(sameSfId(null, OWNER_18)).toBe(false);
    expect(sameSfId(OWNER_18, null)).toBe(false);
  });
});
