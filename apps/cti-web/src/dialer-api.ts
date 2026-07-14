import { api } from './api';

// Type definitions
export interface DialerSessionCounts {
  total: number;
  done: number;
  connected: number;
  noConnect: number;
  skipped: number;
  unreachable: number;
  pending: number;
}

export interface DialerCurrentItem {
  id: string;
  recordId: string;
  objectType: string;
  status: string;
  toNumber: string | null;
}

export interface DialerSession {
  id: string;
  status: 'active' | 'paused' | 'stopped' | 'done';
}

export interface DialerSessionView {
  session: DialerSession;
  counts: DialerSessionCounts;
  currentItem: DialerCurrentItem | null;
}

export type DialerControlAction = 'pause' | 'resume' | 'skip' | 'stop' | 'next';
export type DialerObjectType = 'Lead' | 'Opportunity';

// Pure builder functions
export function dialerControlPath(id: string, action: DialerControlAction): string {
  return `/dialer/sessions/${id}/${action}`;
}

export function startBody(objectType: DialerObjectType, recordIds: string[]): { objectType: DialerObjectType; recordIds: string[] } {
  return { objectType, recordIds };
}

// Async API functions
export async function startDialer(
  objectType: DialerObjectType,
  recordIds: string[]
): Promise<{ sessionId: string; total: number }> {
  return api('/dialer/sessions', {
    method: 'POST',
    body: startBody(objectType, recordIds)
  });
}

export async function getDialer(id: string): Promise<DialerSessionView> {
  return api('/dialer/sessions/' + id, {
    method: 'GET'
  });
}

export async function dialerControl(
  id: string,
  action: DialerControlAction
): Promise<{ ok: boolean }> {
  return api(dialerControlPath(id, action), {
    method: 'POST'
  });
}
