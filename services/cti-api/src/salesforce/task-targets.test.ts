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
  // The rule CHANGED on 2026-09-15: every dialed task rolls forward, not just
  // follow-ups. Leaving 'set appt' and 'reschedule' behind meant a rep could
  // dial all day and watch their list not shrink.
  it('makes every task with a subject eligible to roll, not just follow-ups', () => {
    const lead = { WhoId: '00Q1', Who: { Type: 'Lead' as const } };
    expect(resolveTaskTarget(t({ ...lead, Subject: 'set appt' }))?.followupEligible).toBe(true);
    expect(resolveTaskTarget(t({ ...lead, Subject: 'reschedule' }))?.followupEligible).toBe(true);
    expect(resolveTaskTarget(t({ ...lead, Subject: 'Check in' }))?.followupEligible).toBe(true);
    expect(resolveTaskTarget(t({ ...lead, Subject: 'F/U' }))?.followupEligible).toBe(true);
  });

  // followUpCopyFields defaults a missing subject to 'Follow-up', so rolling a
  // subjectless task would manufacture a follow-up the rep never had.
  it('refuses to roll a task with no subject to copy', () => {
    const lead = { WhoId: '00Q1', Who: { Type: 'Lead' as const } };
    expect(resolveTaskTarget(t({ ...lead, Subject: null }))?.followupEligible).toBe(false);
    expect(resolveTaskTarget(t({ ...lead, Subject: '   ' }))?.followupEligible).toBe(false);
  });
});
