export type Tab = 'dialer' | 'powerdial' | 'recent' | 'team' | 'reputation' | 'admin' | 'calls' | 'settings';

export interface NavTab {
  id: Tab;
  label: string;
}

/**
 * Tabs tucked under the "More" overflow so the bottom bar stays uncrowded — the
 * admin-only tools. Reps never see these (navTabsFor omits them), so their bar
 * has no "More" at all. Order preserved from navTabsFor.
 */
export const NAV_OVERFLOW_IDS: readonly Tab[] = ['team', 'reputation', 'admin', 'calls'];

/**
 * The bottom-nav tabs, in order, for a given rep. Power Dial is a GRANTED
 * capability independent of admin status — the dialer endpoints 403 without
 * it, so an admin without the grant doesn't see the tab either. Team,
 * Reputation, Numbers (`admin`) and Calls are admin-only.
 */
export function navTabsFor(user: { isAdmin: boolean; powerDialerEnabled: boolean }): NavTab[] {
  return [
    { id: 'dialer', label: 'Dial' },
    ...(user.powerDialerEnabled ? ([{ id: 'powerdial', label: 'Power Dial' }] as NavTab[]) : []),
    { id: 'recent', label: 'Recent' },
    ...(user.isAdmin
      ? ([
          { id: 'team', label: 'Team' },
          { id: 'reputation', label: 'Reputation' },
          { id: 'admin', label: 'Numbers' },
          { id: 'calls', label: 'Calls' },
        ] as NavTab[])
      : []),
    { id: 'settings', label: 'Settings' },
  ];
}
