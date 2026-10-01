/**
 * The Call Task a bridged power-dial call becomes, and the worker's retry
 * schedule — pure, so salesforce/dialer-connect-worker.ts only does I/O.
 * Design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md.
 */
import type { DialerConnect } from '@cti/db';
import { orgTodayIso } from '../dialer/org-day.js';
import { buildCallSubject } from './call-subject.js';
import type { CallTaskInput } from './client.js';

/**
 * Backoff before tries 2..6, and the claim's lease for tries 1..6. Starts at
 * 5 minutes on purpose: the claim IS the lease (no in_flight state), so it must
 * outlast a row's worst case — three reads at 30 s, a create at 60 s, our
 * writes — or a second worker could take a row whose Task is still being made.
 */
export const RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000] as const;
/** One try plus five retries. A row whose 6th try fails is `failed`. */
export const MAX_TRIES = RETRY_DELAYS_MS.length + 1;

export function leaseFor(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[i]!;
}

/** Nobody chose a disposition — the call connected, which is exactly what it says. */
export const CONNECT_DISPOSITION = 'Connected';
/** Lean on purpose, like click-to-dial: org automations repost Descriptions. */
export const CONNECT_TASK_DESCRIPTION = 'Logged by the Power Dialer.';

export type TaskLinks = { whoId?: string; whatId?: string };

/** The record the dialer screen-popped: a person is the Who, a deal is the What. */
export function taskLinks(objectType: string, recordId: string): TaskLinks | null {
  if (objectType === 'Lead' || objectType === 'Contact') return { whoId: recordId };
  if (objectType === 'Opportunity') return { whatId: recordId };
  return null;
}

export type ConnectTaskRow = Pick<DialerConnect, 'id' | 'callSid' | 'fromNumber' | 'toNumber' | 'bridgedAt' | 'endedAt' | 'talkSeconds'>;

export function buildConnectTaskInput(row: ConnectTaskRow, links: TaskLinks, recordName: string | null): CallTaskInput {
  return {
    subject: buildCallSubject({ inbound: false, disposition: CONNECT_DISPOSITION, counterpartyE164: row.toNumber, recordName }),
    callType: 'Outbound',
    callDisposition: CONNECT_DISPOSITION,
    callDurationInSeconds: row.talkSeconds ?? undefined,
    // The day the call happened, in the org's timezone — not the day the
    // worker got to it, and never the UTC date.
    activityDate: orgTodayIso(row.bridgedAt),
    ...links,
    description: CONNECT_TASK_DESCRIPTION,
    // Same custom fields as a click-to-dial Task (salesforce/sync.ts), so
    // reports read both alike. createCallTask stamps CTI_Origin__c itself.
    customFields: {
      External_Call_Id__c: row.id,
      Provider_Call_Id__c: row.callSid,
      From_Number__c: row.fromNumber,
      To_Number__c: row.toNumber,
      Normalized_To_Number__c: row.toNumber,
      Call_Start_Time__c: row.bridgedAt.toISOString(),
      Call_End_Time__c: row.endedAt?.toISOString() ?? null,
      CTI_Provider__c: 'twilio',
      Outbound_Caller_ID__c: row.fromNumber,
    },
  };
}
