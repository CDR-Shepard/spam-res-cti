/**
 * One record's offer, read just before its call: the seller's consultations (read even when booking is off, since Sam still
 * mentions them), the property address from the record as it is now, and the routed offer (offer.ts) from the tick's calendars.
 * Never throws: a read that fails costs its part only, logged by error name (record content and Salesforce's error text can
 * carry seller data, so neither is logged).
 */
import { z } from 'zod';
import type { AiCallBookingSettings, AppointmentSlot, CallContext, Consultations, PriorityOffer } from '@cti/contracts';
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
  around: readonly AroundRecord[];
}

/** A record the research found around the one called: its object and id, nothing of its content. */
export interface AroundRecord {
  sfObject: string;
  id: string;
}

export type RecordOfferDeps = OfferDeps & {
  client: SalesforceClient;
  /** The tick's calendars (read once per tenant per tick). */
  calendars: () => Promise<OfferCalendars>;
  /** The tick's Opportunity describe, for the address fields; without it an Opportunity is described per record. */
  oppDescribe?: () => Promise<SObjectDescribe>;
};

/** One record's offer and the seller's consultations (null when they could not be read). */
export interface RecordOffer {
  offer: Offer;
  consultations: Consultations | null;
}

/** What a trigger target carries of a record's offer. */
export interface OfferTargetFields {
  context: CallContext;
  slots?: AppointmentSlot[];
  priority?: PriorityOffer;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const SnapshotRecords = z.object({ records: z.array(z.object({ sfObject: z.string(), id: z.string() })) });

/** A stored research snapshot's records, as `around`; none when the snapshot does not have that shape. */
export function researchAround(snapshot: unknown): AroundRecord[] {
  const parsed = SnapshotRecords.safeParse(snapshot);
  return parsed.success ? parsed.data.records.map(({ sfObject, id }) => ({ sfObject, id })) : [];
}

/**
 * The consultations could not be read, so an upcoming one cannot be ruled out and Sam must not book a second: an offer with
 * times or a priority offer loses them (salesforce_error). One with nothing to drop keeps its note.
 */
function withoutTimes(offer: Offer): Offer {
  if (offer.slots.length === 0 && offer.priority === null) return offer;
  return { ...offer, slots: [], priority: null, ownerSfUserId: null, note: 'salesforce_error' };
}

/** The seller's consultations, or null when they could not be read (readConsultations itself never gives null). */
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

/** The routed offer for the record: its address is read only when routedOffer will need it. */
async function recordOffer(deps: RecordOfferDeps, i: RecordOfferInput, cal: OfferCalendars, consultations: Consultations | null): Promise<Offer> {
  const input = { orgId: i.orgId, booking: i.booking, now: i.now, consultations };
  // routedOffer settles these before it needs an address, so the record is not read for them.
  if (cal.kind === 'none' || consultations?.next) return routedOffer(deps, cal, { ...input, address: null });
  let address: string | null;
  try {
    address = await addressOf(deps, i.record);
  } catch (err) {
    deps.log.warn({ orgId: i.orgId, errName: errName(err) }, 'appointments: could not read the property address; no times offered');
    return noOffer('salesforce_error');
  }
  return routedOffer(deps, cal, { ...input, address });
}

/**
 * The property address (readCurrent), the consultations (a read error → null, logged by errName, and then no times: see
 * withoutTimes) and routedOffer. Never throws.
 */
export async function offerForRecord(deps: RecordOfferDeps, i: RecordOfferInput): Promise<RecordOffer> {
  const [consultations, cal] = await Promise.all([consultationsOf(deps, i), calendarsOf(deps, i.orgId)]);
  const offer = await recordOffer(deps, i, cal, consultations);
  return { offer: consultations === null ? withoutTimes(offer) : offer, consultations };
}

/**
 * A trigger target's context and offer: the consultations when one was found (a past or an upcoming one), the slots when there
 * are any, and the high-priority offer whenever it is set. An offer with a note can still carry it (no_reps), so the note
 * never decides. None found sends no consultations key: CallContext is strict, so an older cti-api would refuse every trigger
 * that carried one, and "checked, none" means nothing to cti-api. `offered` null (nothing read, or a kept key re-sent, CF-13)
 * carries the returning flag alone.
 */
export function offerTargetFields(returning: boolean, offered: RecordOffer | null): OfferTargetFields {
  const read = offered?.consultations ?? null;
  const consultations = read && (read.last || read.next) ? read : null;
  const slots = offered?.offer.slots ?? [];
  const priority = offered?.offer.priority ?? null;
  return {
    context: { returning, ...(consultations ? { consultations } : {}) },
    ...(slots.length ? { slots } : {}),
    ...(priority ? { priority } : {}),
  };
}
