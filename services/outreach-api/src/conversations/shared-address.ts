/**
 * How far one seller's stop reaches through a shared email address. A duplicate Lead of the same seller carries the
 * same address, so an opt-out on one record stops the others too (conversations/store.ts sweepSeller) and keeps Sam
 * from calling a duplicate synced later (ai-calls/touches.ts). But an address can sit on many records that are NOT one
 * seller: an agent's or a title company's inbox on dozens of Leads (Salesforce shows one address on up to 91). Past
 * SHARED_ADDRESS_LIMIT records the address says nothing about who the seller is, so the stop applies to the seller's
 * own record only, the address stays suppressed for email (an email opt-out is about the address) and a person is
 * asked to decide about the other records.
 *
 * No imports from the store or the touches: both read the limit, and the store imports the touches.
 */
import type { AlertEvent } from '../alerts.js';
import { describeError } from '../email/errors.js';

/** An address on more of the tenant's records than this does not identify one seller: a stop does not spread through it. */
export const SHARED_ADDRESS_LIMIT = 5;

/**
 * The suppression reasons that are a seller's stop (asked_to_stop is stored as opted_out): they hold an AI call to a
 * record with the address (ai-calls/touches.ts), and one replaces a stored `bounced` (store.ts suppressAddress). A
 * bounce alone is about the mailbox, not the seller: it holds no call.
 */
export const STOP_SUPPRESSIONS = ['opted_out', 'complained'] as const;

/**
 * A stop that did not spread to other records because an address of the stop is on more than SHARED_ADDRESS_LIMIT of
 * them. `sharedRecordCount` is how many of the tenant's records carry such an address. Ids and a count only.
 */
export interface SharedAddressNotice {
  orgId: string;
  conversationId: string;
  sharedRecordCount: number;
}

/** Told inside the stop's transaction; the caller raises the alert only after its own transaction commits. */
export type OnSharedAddress = (notice: SharedAddressNotice) => void;

/**
 * What one transaction's stops were told: pass `onSharedAddress` to them, and once the transaction has committed raise an
 * alert for each of `notices()`. Made inside the transaction's callback, so a rolled-back attempt leaves nothing behind.
 */
export function sharedAddressCollector(): { onSharedAddress: OnSharedAddress; notices: () => readonly SharedAddressNotice[] } {
  const seen: SharedAddressNotice[] = [];
  return { onSharedAddress: (notice) => void seen.push(notice), notices: () => [...seen] };
}

interface AlertLog {
  error: (obj: unknown, msg?: string) => void;
}

/**
 * The one `seller_needs_person` alert for a stop that did not spread. Never throws: a failing alert is logged by name.
 * Its context is the conversation id and the record count only, never the address.
 */
export async function raiseSharedAddressAlert(
  deps: { alert: (event: AlertEvent) => Promise<void>; log: AlertLog },
  notice: SharedAddressNotice,
): Promise<void> {
  try {
    await deps.alert({
      kind: 'seller_needs_person',
      severity: 'warning',
      orgId: notice.orgId,
      message: `A seller asked to stop at an address ${notice.sharedRecordCount} records share; only the seller's own record was stopped. A person must decide about the others.`,
      context: { conversationId: notice.conversationId, sharedRecordCount: notice.sharedRecordCount },
    });
  } catch (err) {
    deps.log.error({ alert: 'seller_needs_person', conversationId: notice.conversationId, ...describeError(err) }, 'shared address alert failed');
  }
}
