import { describe, expect, it } from 'vitest';
import { navTabsFor, NAV_OVERFLOW_IDS } from './nav';

const rep = { isAdmin: false, powerDialerEnabled: false };

describe('navTabsFor', () => {
  it('a rep without power dial sees only Dial/Recent/Settings', () => {
    expect(navTabsFor(rep).map((t) => t.id)).toEqual(['dialer', 'recent', 'settings']);
  });

  it('power dial appears only when granted — for reps AND admins', () => {
    expect(navTabsFor({ ...rep, powerDialerEnabled: true }).map((t) => t.id))
      .toEqual(['dialer', 'powerdial', 'recent', 'settings']);
    // An admin WITHOUT the grant does not get the tab either (flag ⊥ admin).
    expect(navTabsFor({ isAdmin: true, powerDialerEnabled: false }).map((t) => t.id))
      .not.toContain('powerdial');
  });

  it('admins get Team and Talk time in the More overflow, beside Reputation', () => {
    const ids = navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => t.id);
    expect(ids).toEqual(['dialer', 'powerdial', 'recent', 'team', 'talktime', 'reputation', 'admin', 'calls', 'settings']);
    expect(NAV_OVERFLOW_IDS).toEqual(['team', 'talktime', 'reputation', 'admin', 'calls']);
  });

  it('reps never see Talk time', () => {
    expect(navTabsFor({ ...rep, powerDialerEnabled: true }).map((t) => t.id)).not.toContain('talktime');
  });

  it('labels are stable', () => {
    const byId = Object.fromEntries(navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => [t.id, t.label]));
    expect(byId).toMatchObject({ team: 'Team', talktime: 'Talk time', admin: 'Numbers', reputation: 'Reputation', dialer: 'Dial' });
  });
});
