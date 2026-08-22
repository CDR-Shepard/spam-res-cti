import { describe, expect, it } from 'vitest';
import { resolveTaskTarget, type TaskRow } from './task-targets.js';

const t = (o: Partial<TaskRow>): TaskRow => ({ Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: null, WhatId: null, ...o });

describe('resolveTaskTarget', () => {
  it('a Lead Who wins', () => {
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, WhatId: '0061', What: { Type: 'Opportunity' } })))
      .toEqual({ recordId: '00Q1', objectType: 'Lead', followupEligible: true });
  });
  it('a Contact Who is dialable (new object)', () => {
    expect(resolveTaskTarget(t({ WhoId: '0031', Who: { Type: 'Contact' } }))?.objectType).toBe('Contact');
  });
  it('no Who but an Opportunity What → the opportunity', () => {
    expect(resolveTaskTarget(t({ WhatId: '0061', What: { Type: 'Opportunity' } }))?.objectType).toBe('Opportunity');
  });
  it('anything else is unreachable (null)', () => {
    expect(resolveTaskTarget(t({ WhatId: '0011', What: { Type: 'Account' } }))).toBeNull();
    expect(resolveTaskTarget(t({}))).toBeNull();
  });
  it('followupEligible comes from the subject rule', () => {
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, Subject: 'Check in' }))?.followupEligible).toBe(false);
    expect(resolveTaskTarget(t({ WhoId: '00Q1', Who: { Type: 'Lead' }, Subject: 'F/U' }))?.followupEligible).toBe(true);
  });
});
