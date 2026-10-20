/**
 * The seller's consultation Events, read before a call so Sam knows whether there was one before (when, who, in person or by
 * phone) and whether one is already booked ahead.
 *
 * The Event Subject can carry the seller's name and address: it is read only to tell a phone consultation from an in-person
 * one, and is never returned, logged or stored.
 */
import { ConsultationFact, type Consultations } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import { soqlIdList } from '../research/text.js';

export interface ConsultationLinks { whoIds: string[]; whatIds: string[] }

/** Where an Event can hang a record, by object: the Who or What side, and the key prefix its ids carry. */
const SIDES: Readonly<Record<string, { side: keyof ConsultationLinks; prefix: string }>> = {
  Lead: { side: 'whoIds', prefix: '00Q' },
  Contact: { side: 'whoIds', prefix: '003' },
  Opportunity: { side: 'whatIds', prefix: '006' },
};

/** Salesforce compares ids on their case-sensitive 15-character core. */
const idCore = (id: string): string => id.slice(0, 15);

/**
 * The record itself plus the research records around it: Leads and Contacts as Who, Opportunities as What (Accounts hold no
 * consultation Events). Bad ids, and ids whose key prefix is not their object's, are dropped; each id is kept once by its
 * 15-character core, in the first form seen.
 */
export function consultationLinks(
  record: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string },
  around: ReadonlyArray<{ sfObject: string; id: string }> = [],
): ConsultationLinks {
  const seen = new Set<string>();
  const links: ConsultationLinks = { whoIds: [], whatIds: [] };
  for (const { sfObject, id } of [{ sfObject: record.sfObject, id: record.sfRecordId }, ...around]) {
    const target = SIDES[sfObject];
    if (!target || !SF_ID.test(id) || !id.startsWith(target.prefix) || seen.has(idCore(id))) continue;
    seen.add(idCore(id));
    links[target.side].push(id);
  }
  return links;
}

export const CONSULTATION_EVENT_LIMIT = 50;

/** The consultation Events on these records, newest first; null when there is no record to ask about. */
export function consultationsSoql(links: ConsultationLinks): string | null {
  const parts = [
    ...(links.whoIds.length ? [`WhoId IN (${soqlIdList(links.whoIds)})`] : []),
    ...(links.whatIds.length ? [`WhatId IN (${soqlIdList(links.whatIds)})`] : []),
  ];
  if (parts.length === 0) return null;
  return (
    "SELECT StartDateTime, Subject, Owner.Name FROM Event WHERE Subject LIKE '%Consultation%' AND IsAllDayEvent = false " +
    `AND (${parts.join(' OR ')}) ORDER BY StartDateTime DESC LIMIT ${CONSULTATION_EVENT_LIMIT}`
  );
}

type Row = Record<string, unknown>;
interface Dated { at: number; fact: ConsultationFact }

/**
 * A phone consultation's Subject says so as a phrase. A bare "phone" is not enough: an in-person Subject carries the
 * property address ("Property Consultation 40 Telephone Rd"), and Sam must not call that a phone consultation.
 */
const PHONE_SUBJECT = /\bphone\s+consultation\b/i;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The owner's name when the contract lets Sam say it, else null. */
function ownerNameOf(row: Row): string | null {
  const owner = row.Owner;
  const name = str(owner !== null && typeof owner === 'object' ? (owner as Row).Name : null);
  return name !== null && ConsultationFact.shape.ownerName.safeParse(name).success ? name : null;
}

/** A row's fact and start, or null when it has no readable start. The Subject only decides `kind`. */
function toDated(row: Row): Dated | null {
  const raw = str(row.StartDateTime);
  const start = raw === null ? null : new Date(raw);
  if (start === null || Number.isNaN(start.getTime())) return null;
  const kind = PHONE_SUBJECT.test(str(row.Subject) ?? '') ? 'phone' : 'in_person';
  return { at: start.getTime(), fact: { start: start.toISOString(), kind, ownerName: ownerNameOf(row) } };
}

/**
 * The latest consultation that started before `now`, and the earliest at or after it. A Salesforce error is thrown, not
 * swallowed: the caller decides how the call goes on without them.
 */
export async function readConsultations(client: SalesforceClient, links: ConsultationLinks, now: Date): Promise<Consultations> {
  const soql = consultationsSoql(links);
  if (soql === null) return { last: null, next: null };
  const dated = (await client.query<Row>(soql)).flatMap((row) => toDated(row) ?? []);
  const nowMs = now.getTime();
  const past = dated.filter((d) => d.at < nowMs).sort((a, b) => b.at - a.at);
  const upcoming = dated.filter((d) => d.at >= nowMs).sort((a, b) => a.at - b.at);
  return { last: past[0]?.fact ?? null, next: upcoming[0]?.fact ?? null };
}
