import type { DialerItem } from './session-store.js';

export function inFlightItem(items: DialerItem[]): DialerItem | null {
  return items.find((i) => i.status === 'dialing' || i.status === 'connected') ?? null;
}

export function nextPendingItem(items: DialerItem[]): DialerItem | null {
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));
}

export function outcomeToStatus(outcome: 'connected' | 'no_connect'): 'connected' | 'no_connect' {
  return outcome;
}

export function allTerminal(items: DialerItem[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'dialing' || i.status === 'connected');
}
