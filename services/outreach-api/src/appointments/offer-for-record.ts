/**
 * One record's offer, read just before its call: the seller's consultations (read even when booking is off, since Sam still
 * mentions them), the property address from the record as it is now, and the routed offer (offer.ts) from the tick's calendars.
 * Never throws: a read that fails costs its part only, logged by error name (record content and Salesforce's error text can
 * carry seller data, so neither is logged).
 */
import type { AiCallBookingSettings, Consultations } from '@cti/contracts';
import type { SalesforceClient, SObjectDescribe } from '@cti/salesforce';
import { readCurrent } from '../writeback/fields.js';
import { consultationLinks, readConsultations } from './consultations.js';
import { noOffer, routedOffer, type Offer, type OfferCalendars, type OfferDeps } from './offer.js';

export interface RecordOfferInput {
  orgId: string;
  booking: AiCallBookingSettings;
  now: Date;
  record: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string };
  /** The research records around it (a converted Lead's Contact and Opportunity, the other Opportunities…). */
  around: ReadonlyArray<{ sfObject: string; id: string }>;
}

export type RecordOfferDeps = OfferDeps & {
  client: SalesforceClient;
  /** The tick's calendars (read once per tenant per tick). */
  calendars: () => Promise<OfferCalendars>;
  /** The tick's Opportunity describe, for the address fields; without it an Opportunity is described per record. */
  oppDescribe?: () => Promise<SObjectDescribe>;
};

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

async function consultationsOf(deps: RecordOfferDeps, i: RecordOfferInput): Promise<Consultations | null> {
  try {
    return await readConsultations(deps.client, consultationLinks(i.record, i.around), i.now);
  } catch (err) {
    deps.log.warn({ orgId: i.orgId, errName: errName(err) }, 'appointments: could not read the seller\'s consultations');
    return null;
  }
}

async function calendarsOf(deps: RecordOfferDeps, orgId: string): Promise<OfferCalendars> {
  try {
    return await deps.calendars();
  } catch (err) {
    deps.log.warn({ orgId, errName: errName(err) }, 'appointments: could not read the reps\' calendars; no times offered');
    return { kind: 'none', note: 'salesforce_error' };
  }
}

/** The property address; a converted Lead, or a record Salesforce does not return, has none. Rejects on a Salesforce error. */
async function addressOf(deps: RecordOfferDeps, record: RecordOfferInput['record']): Promise<string | null> {
  const describe = record.sfObject === 'Opportunity' && deps.oppDescribe ? await deps.oppDescribe() : undefined;
  return (await readCurrent(deps.client, record.sfObject, record.sfRecordId, [], describe))?.address ?? null;
}

/** The property address (readCurrent), the consultations (a read error → null, logged by errName) and routedOffer. Never throws. */
export async function offerForRecord(deps: RecordOfferDeps, i: RecordOfferInput): Promise<{ offer: Offer; consultations: Consultations | null }> {
  const [consultations, cal] = await Promise.all([consultationsOf(deps, i), calendarsOf(deps, i.orgId)]);
  const input = { orgId: i.orgId, booking: i.booking, now: i.now, consultations };
  // routedOffer settles these before it needs an address, so the record is not read for them.
  if (cal.kind === 'none' || consultations?.next) return { offer: await routedOffer(deps, cal, { ...input, address: null }), consultations };
  let address: string | null;
  try {
    address = await addressOf(deps, i.record);
  } catch (err) {
    deps.log.warn({ orgId: i.orgId, errName: errName(err) }, 'appointments: could not read the property address; no times offered');
    return { offer: noOffer('salesforce_error'), consultations };
  }
  return { offer: await routedOffer(deps, cal, { ...input, address }), consultations };
}
