import type { ContactChannel, SkipReason } from '@cti/contracts';
import type { ConsentBlock } from '@cti/firewall';
import type { SfRecordSnapshot } from './records.js';

/** Strongest first: what a skipped record is reported as when several reasons removed its channels. */
const SUPPRESSION_ORDER = ['opted_out', 'blocked', 'dnc', 'sf_do_not_call', 'sf_email_opt_out'] as const satisfies readonly SkipReason[];

/** Texting needs a mobile: Lead MobilePhone, Opportunity Mobile_Phone__c, Contact.MobilePhone. */
const MOBILE_FIELD = /mobile/i;

/** Pure: the keys that make "one active campaign per person" (spec §6.3) — every E.164 and the lowercased email. */
export function contactKeys(s: SfRecordSnapshot): string[] {
  const email = s.email ? [s.email.trim().toLowerCase()] : [];
  return [...new Set([...s.phones.map((p) => p.e164), ...email])];
}

/** Pure: the channels this record can be reached on today, before campaign rules (the planner, A10, applies those). */
export function availableChannels(s: SfRecordSnapshot, blocks: ReadonlyMap<string, ConsentBlock>): ContactChannel[] {
  const usable = s.sfDoNotCall ? [] : s.phones.filter((p) => !blocks.has(p.e164));
  const channels: ContactChannel[] = [];
  if (usable.length > 0) channels.push('call');
  if (usable.some((p) => MOBILE_FIELD.test(p.field))) channels.push('sms');
  if (s.email && !s.sfEmailOptOut) channels.push('email');
  return channels;
}

/**
 * Pure: why this record would not enroll, or null. Order: closed,
 * in_other_campaign, skip_on_dialer; then, only when no channel remains, the
 * strongest suppression that removed one, else no_contact_point.
 */
export function skipReasonFor(s: SfRecordSnapshot, blocks: ReadonlyMap<string, ConsentBlock>, inOtherCampaign: boolean): SkipReason | null {
  if (s.isClosed) return 'closed';
  if (inOtherCampaign) return 'in_other_campaign';
  if (s.skipOnDialer) return 'skip_on_dialer';
  if (availableChannels(s, blocks).length > 0) return null;
  const present = new Set<SkipReason>(s.phones.flatMap((p) => {
    const block = blocks.get(p.e164);
    return block ? [block] : [];
  }));
  if (s.sfDoNotCall && s.phones.length > 0) present.add('sf_do_not_call');
  if (s.sfEmailOptOut && s.email) present.add('sf_email_opt_out');
  return SUPPRESSION_ORDER.find((reason) => present.has(reason)) ?? 'no_contact_point';
}
