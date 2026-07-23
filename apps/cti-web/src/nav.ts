export type Tab = 'dialer' | 'powerdial' | 'recent' | 'reputation' | 'admin' | 'calls' | 'settings';

export interface NavTab {
  id: Tab;
  label: string;
}

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
