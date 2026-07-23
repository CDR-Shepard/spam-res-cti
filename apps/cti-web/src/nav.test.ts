import { describe, expect, it } from 'vitest';
import { navTabsFor } from './nav';

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
});
