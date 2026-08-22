import { describe, expect, it } from 'vitest';
import { countFollowUps, isFollowUpSubject } from './followup-subject.js';

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
