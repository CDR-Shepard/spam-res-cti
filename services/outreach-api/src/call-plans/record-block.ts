/**
 * The record-level reasons a call would be refused (no phone, Do Not Call or Skip on Dialer in Salesforce,
 * a number on the block list), checked at approval with the SAME rule the board and the release use:
 * `gateWarnings` and its blocking set. The engine still re-checks at call time and stays the only authority.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AiConsentStatus } from '@cti/contracts';
import type { Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import { gateWarnings, hasBlockingWarning } from './warnings.js';

/** Select-list columns (`crm_records` aliased `r`) that `recordIsBlocked` reads. */
export const RECORD_BLOCK_COLUMNS = sql`r.phones as "phones", r.sf_do_not_call as "sfDoNotCall", r.skip_on_dialer as "skipOnDialer", r.is_closed as "isClosed", r.state as "state"`;

export interface BlockableRecord {
  phones: unknown;
  sfDoNotCall: boolean;
  skipOnDialer: boolean;
  isClosed: boolean;
  state: string | null;
}

const Phones = z.array(z.object({ field: z.string(), e164: z.string() })).catch([]);

/** True when the record has a blocking warning as things stand. */
export async function recordIsBlocked(tx: Db, orgId: string, record: BlockableRecord, consent: AiConsentStatus, now: Date): Promise<boolean> {
  const phones = Phones.parse(record.phones);
  const blocks = await blockedTargets(tx, orgId, [...new Set(phones.map((p) => p.e164))]);
  const warnings = gateWarnings({
    consent,
    record: { phones, sfDoNotCall: record.sfDoNotCall, skipOnDialer: record.skipOnDialer, isClosed: record.isClosed, state: record.state },
    blocks,
    now,
  });
  return hasBlockingWarning(warnings);
}
