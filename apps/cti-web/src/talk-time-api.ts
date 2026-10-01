import { api } from './api';

export type TalkSource = 'outbound' | 'powerDial' | 'inbound';

export interface TalkDay {
  day: string;
  talkSeconds: number;
  connectedCalls: number;
  dialerSeconds: number;
}

export interface TalkRep {
  userId: string;
  name: string;
  talkSeconds: number;
  connectedCalls: number;
  bySource: Record<TalkSource, { calls: number; seconds: number }>;
  dialerSeconds: number;
  days: TalkDay[];
}

export interface TalkTimeReport {
  from: string;
  to: string;
  timezone: string;
  reps: TalkRep[];
  totals: { talkSeconds: number; connectedCalls: number; dialerSeconds: number };
}

/** Admin-only: talk time per rep over the org's Pacific days from..to (inclusive). */
export async function getTalkTime(from: string, to: string): Promise<TalkTimeReport> {
  return api(`/admin/talk-time?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: 'GET' });
}
