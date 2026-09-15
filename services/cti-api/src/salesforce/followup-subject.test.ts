import { describe, expect, it } from 'vitest';
import { countFollowUps, isFollowUpSubject, sameTaskKind, countCtiCreated } from './followup-subject.js';

describe('isFollowUpSubject', () => {
  it('matches every agreed spelling, any case, anywhere in the subject', () => {
    for (const s of ['Follow-up', 'follow up with Maria', 'FOLLOWUP', 'FU: call back', 'F/U re: offer', 'F-U', '2nd f/u', 'Call - FU']) {
      expect(isFollowUpSubject(s), s).toBe(true);
    }
  });
  it('does NOT match FU inside another word', () => {
    for (const s of ['Refund request', 'FUEL surcharge', 'Send contract', 'Check in', null, undefined, '']) {
      expect(isFollowUpSubject(s), String(s)).toBe(false);
    }
  });
});

describe('countFollowUps', () => {
  it('counts only subject matches', () => {
    expect(countFollowUps([{ Subject: 'FU' }, { Subject: 'Refund' }, { Subject: null }, { Subject: 'Follow up' }])).toBe(2);
  });
});

/**
 * Which same-day tasks a rollover clears alongside the one the rep dialed.
 * Since 2026-09-15 every dialed task rolls, so this has to distinguish kinds —
 * a 'set appt' rollover must never complete a follow-up the rep never called.
 */
describe('sameTaskKind', () => {
  it('matches follow-ups to each other across the org\'s many spellings', () => {
    expect(sameTaskKind('Follow up', 'F/U')).toBe(true);
    expect(sameTaskKind('follow-up call', 'Followup')).toBe(true);
  });

  it('NEVER matches a non-follow-up to a follow-up, in either direction', () => {
    expect(sameTaskKind('set appt', 'Follow up')).toBe(false);
    expect(sameTaskKind('Follow up', 'set appt')).toBe(false);
  });

  it('matches other subjects only to the same subject', () => {
    expect(sameTaskKind('set appt', 'set appt')).toBe(true);
    expect(sameTaskKind('set appt', '  SET APPT ')).toBe(true);
    expect(sameTaskKind('set appt', 'reschedule')).toBe(false);
  });

  it('treats a missing or blank subject as matching nothing', () => {
    expect(sameTaskKind(null, null)).toBe(false);
    expect(sameTaskKind('', '')).toBe(false);
    expect(sameTaskKind('set appt', null)).toBe(false);
    expect(sameTaskKind(null, 'set appt')).toBe(false);
  });
});

describe('countCtiCreated', () => {
  it('counts only the tasks the CTI stamped', () => {
    expect(countCtiCreated([
      { CTI_Origin__c: 'Power Dialer Follow-Up' },
      { CTI_Origin__c: 'Call Log' },
      { CTI_Origin__c: null },
      {},
    ])).toBe(2);
  });

  it('is zero for a day of purely hand-made work', () => {
    expect(countCtiCreated([{ CTI_Origin__c: null }, {}])).toBe(0);
  });
});
