import { describe, expect, it } from 'vitest';
import { stickyUpsertValues } from './sticky.js';

describe('stickyUpsertValues', () => {
  it('binds (org, agent, lead) → pool DID', () => {
    expect(stickyUpsertValues({ orgId: 'O', userId: 'U', leadE164: '+1619', poolDid: '+1213' })).toEqual({
      orgId: 'O', assignedUserId: 'U', recipientE164: '+1619', e164: '+1213',
    });
  });
});
