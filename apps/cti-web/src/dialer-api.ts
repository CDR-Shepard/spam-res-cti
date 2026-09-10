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
  /** 1 or 2 — the second try of the day for this record. */
  attempt?: number;
  /** The DID the call went out on. */
  fromNumber?: string | null;
  /** Why a miss missed — voicemail, no_answer, busy, failed, … (server
   *  `dialer/outcome.ts`). Set once the row settles; null while dialing. */
  outcome?: string | null;
}

export interface DialerSession {
  id: string;
  status: 'ready' | 'active' | 'paused' | 'stopped' | 'done';
}

export interface DialerRollovers { moved: number; pushed: number; failed: number; pending: number }

export interface DialerSessionView {
  session: DialerSession;
  counts: DialerSessionCounts;
  currentItem: DialerCurrentItem | null;
  /** Set when the run is idle only because its retries are inside the 5-min floor. */
  waitingRetry?: { nextRetryAt: string } | null;
  rollovers?: DialerRollovers;
  /** Per-outcome tally of skipped rows (see `session-store.ts#skipBreakdown`
   *  on the server) — what the rep inherited when the run started. */
  skipBreakdown?: Record<string, number>;
  /** Attempt-1 rows only: the size of the queue creation built. `counts.total`
   *  grows as retries are appended, so this is what the start-of-run line
   *  reports. Optional — an older server omits it. */
  firstPassTotal?: number;
  /** Per-reason tally of no_connect rows (server `session-store.ts#missBreakdown`). */
  missBreakdown?: Record<string, number>;
}

export type DialerControlAction = 'start' | 'pause' | 'resume' | 'skip' | 'stop' | 'next';
export type DialerObjectType = 'Lead' | 'Opportunity' | 'Task';
export const OBJECT_LABELS: Record<DialerObjectType, string> = {
  Lead: 'Leads',
  Opportunity: 'Opportunities',
  Task: 'Tasks',
};

export interface PendingHandoff {
  objectType: DialerObjectType;
  recordIds: string[];
}

// Pure builder functions
export function dialerControlPath(id: string, action: DialerControlAction): string {
  return `/dialer/sessions/${id}/${action}`;
}

export function startBody(objectType: DialerObjectType, recordIds: string[]): { objectType: DialerObjectType; recordIds: string[] } {
  return { objectType, recordIds };
}

// Async API functions
/** Pull a Salesforce list view's records and create a READY run over them — nothing dials until dialerControl(id, 'start'). */
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

// Polled by App.tsx while signed in and no dialer session is active — a
// non-null handoff means Salesforce Apex relayed a Power Dial start for this
// rep (see services/cti-api routes/dialer.ts GET /dialer/handoffs/pending).
export async function getPendingHandoff(): Promise<{ handoff: PendingHandoff | null }> {
  return api('/dialer/handoffs/pending', {
    method: 'GET'
  });
}

export interface SalesforceListView {
  id: string;
  label: string;
  developerName: string;
}

/** The rep's Salesforce list views for the object (fetched via their token). */
export async function getSalesforceListViews(
  object: DialerObjectType
): Promise<{ listViews: SalesforceListView[] }> {
  return api('/dialer/salesforce/listviews?object=' + object, { method: 'GET' });
}

/** Pull a Salesforce list view's records and create a READY run over them — nothing dials until dialerControl(id, 'start'). */
export async function startDialerFromListView(
  object: DialerObjectType,
  listViewId: string
): Promise<{ sessionId: string; total: number; recordCount: number }> {
  return api('/dialer/sessions/from-listview', {
    method: 'POST',
    body: { object, listViewId }
  });
}
