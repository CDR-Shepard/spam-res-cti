export type Tab = 'dialer' | 'powerdial' | 'recent' | 'reputation' | 'admin' | 'calls' | 'settings';

export interface NavTab {
  id: Tab;
  label: string;
}

/**
 * Tabs tucked under the "More" overflow so the bottom bar stays uncrowded — the
 * admin-only tools. Reps never see these (navTabsFor omits them), so their bar
 * has no "More" at all. Order preserved from navTabsFor.
 */
export const NAV_OVERFLOW_IDS: readonly Tab[] = ['reputation', 'admin', 'calls'];

/**
 * The bottom-nav tabs, in order, for a given rep. Reputation, Numbers (`admin`)
 * and Calls are admin-only (the corresponding endpoints also 403 non-admins);
 * every rep gets Dial, Power Dial, Recent, and Settings.
 */
export function navTabsFor(isAdmin: boolean): NavTab[] {
  return [
    { id: 'dialer', label: 'Dial' },
    { id: 'powerdial', label: 'Power Dial' },
    { id: 'recent', label: 'Recent' },
    ...(isAdmin
      ? ([
          { id: 'reputation', label: 'Reputation' },
          { id: 'admin', label: 'Numbers' },
          { id: 'calls', label: 'Calls' },
        ] as NavTab[])
      : []),
    { id: 'settings', label: 'Settings' },
  ];
}
