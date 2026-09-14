import { describe, expect, it } from 'vitest';

import { followUpCopyFields, pickFollowUpTask, type FollowUpTask } from './followup.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD } from './cti-origin.js';

const t = (o: Partial<FollowUpTask>): FollowUpTask => ({
  Id: 'x', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal',
  OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-07-10', ...o,
});

describe('pickFollowUpTask', () => {
  it('ignores non-follow-up subjects', () => {
    expect(pickFollowUpTask([t({ Subject: 'Send contract' })])).toBeNull();
  });
  it('matches the three spellings, case-insensitively', () => {
    for (const s of ['Follow-up', 'Followup', 'follow up call', 'FOLLOW-UP']) {
      expect(pickFollowUpTask([t({ Subject: s })])).not.toBeNull();
    }
  });
  it('returns the earliest-due matching task', () => {
    const picked = pickFollowUpTask([
      t({ Id: 'a', ActivityDate: '2026-07-12' }),
      t({ Id: 'b', ActivityDate: '2026-07-08' }),
      t({ Id: 'c', ActivityDate: null }),
    ]);
    expect(picked?.Id).toBe('b');
  });
});

describe('followUpCopyFields', () => {
  it('copies core fields, drops null Who/What, sets due date + open status', () => {
    const f = followUpCopyFields(t({ WhatId: null, WhoId: '00Q9' }), '2026-07-14');
    expect(f).toMatchObject({
      Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005',
      WhoId: '00Q9', Status: 'Not Started', ActivityDate: '2026-07-14',
    });
    expect('WhatId' in f).toBe(false);
  });

  // The marker is how the "Power Dialer Follow-Ups" Salesforce report tells a
  // rolled-forward copy from a follow-up someone typed by hand.
  it('stamps the CTI Origin marker so reports can identify the copy', () => {
    const f = followUpCopyFields(t({}), '2026-07-14');
    expect(f[CTI_ORIGIN_FIELD]).toBe(CTI_ORIGIN.followUp);
  });
});
