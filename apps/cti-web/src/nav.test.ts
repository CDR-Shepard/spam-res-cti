import { describe, expect, it } from 'vitest';
import { navTabsFor, NAV_OVERFLOW_IDS, type Tab } from './nav';

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

  it('has no AI calls tab: AI calls start from outreach campaigns, not the softphone', () => {
    expect(navTabsFor(rep).map((t) => t.id)).not.toContain('aicalls');
    expect(navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => t.id)).not.toContain('aicalls');
    // @ts-expect-error 'aicalls' is no longer a Tab
    const gone: Tab = 'aicalls';
    expect(gone).toBe('aicalls'); // only here to use the value; the type error above is the check
  });
});
