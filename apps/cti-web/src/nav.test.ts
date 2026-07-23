import { describe, expect, it } from 'vitest';
import { navTabsFor, NAV_OVERFLOW_IDS } from './nav';

describe('navTabsFor', () => {
  it('a rep (non-admin) sees only rep tabs — no Reputation, Numbers, or Calls', () => {
    expect(navTabsFor(false).map((t) => t.id)).toEqual(['dialer', 'powerdial', 'recent', 'settings']);
  });

  it('an admin sees every tab, with Reputation/Numbers/Calls between Recent and Settings', () => {
    expect(navTabsFor(true).map((t) => t.id)).toEqual([
      'dialer', 'powerdial', 'recent', 'reputation', 'admin', 'calls', 'settings',
    ]);
  });

  it('labels are stable', () => {
    const byId = Object.fromEntries(navTabsFor(true).map((t) => [t.id, t.label]));
    expect(byId).toMatchObject({ admin: 'Numbers', calls: 'Calls', reputation: 'Reputation', dialer: 'Dial' });
  });

  it('the overflow ("More") set is exactly the admin-only tools — and reps have none of them', () => {
    expect(NAV_OVERFLOW_IDS).toEqual(['reputation', 'admin', 'calls']);
    // Every rep tab is a PRIMARY tab (none live under More).
    expect(navTabsFor(false).every((t) => !NAV_OVERFLOW_IDS.includes(t.id))).toBe(true);
    // For an admin, the overflow tabs are all present in the full nav.
    const adminIds = navTabsFor(true).map((t) => t.id);
    expect(NAV_OVERFLOW_IDS.every((id) => adminIds.includes(id))).toBe(true);
  });
});
