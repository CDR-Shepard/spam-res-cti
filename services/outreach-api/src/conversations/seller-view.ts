/**
 * What a seller's page shows (GET /sellers/:sfRecordId/conversation) and why Sam may or may not email the seller
 * right now. Read-only: a seller who has no conversation row yet reads as open, handled by Sam, with the calls alone
 * on the timeline, and nothing here creates the row (a page view must not).
 *
 * The page shows the REAL conversation only. An admin's practice conversation (their own copy of Sam's email) is a
 * separate row that never appears here.
 *
 * Why Sam may not email, in the order the page explains it: the server has no email setup or no writer
 * (`not_configured`), the tenant's switch is off or paused, the record has no usable address, and then outbox.ts's
 * own rules for a first email (`sellerBlock`: no call plan a person approved, a closed record, the conversation,
 * suppression, Salesforce Email Opt Out on any record with the address), so the page and the send tick never disagree.
 *
 * Every statement is scoped by tenant. No log line here (it writes none), so no address or name can reach one.
 */
import { sql } from 'drizzle-orm';
import { FlagReason, StopReason, type ConversationView, type EmailBlock } from '@cti/contracts';
import type { Db } from '@cti/db';
import { loadConnection } from '../crm/connection-store.js';
import { addressBlocks, hasApprovedPlan, phonesOf, sellerBlock, switchBlock } from '../email/outbox.js';
import { SF_ID_CORE } from '../tenancy/record-owner.js';
import { forPage, readTimeline } from './timeline.js';

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
/** Enough of an address to hand to Resend: one @, something either side, a dot in the domain, no spaces. */
const ADDRESS_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SellerRecord {
  id: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  name: string | null;
  ownerSfUserId: string | null;
  /** The record's email, trimmed; null when there is none Sam could send to. */
  address: string | null;
  isClosed: boolean;
  /** This record's own Salesforce Email Opt Out; sellerEmailBlock also reads the other records with the address. */
  sfEmailOptOut: boolean;
  phones: Array<{ e164: string }>;
}

/** The seller's real conversation as the page needs it; null when there is none yet. */
export interface ConversationState {
  id: string;
  status: 'open' | 'booked' | 'stopped';
  stopReason: string | null;
  flagReason: string | null;
  handler: 'sam' | 'person';
  /** The person handling the seller, by name; null while Sam handles them. */
  handlerName: string | null;
}

/**
 * This tenant's record with this Salesforce id, or null (another tenant's record reads as none). An 18-character id
 * matches whole; a 15-character one matches the stored id's case-sensitive 15-character core, the same record.
 */
export async function findSeller(db: Db, orgId: string, sfRecordId: string): Promise<SellerRecord | null> {
  const match = sfRecordId.length === SF_ID_CORE ? sql`left(sf_record_id, ${SF_ID_CORE}::int) = ${sfRecordId}` : sql`sf_record_id = ${sfRecordId}`;
  const result = await db.execute(sql`
    select id, sf_object as "sfObject", sf_record_id as "sfRecordId", name, owner_sf_user_id as "ownerSfUserId", btrim(email) as email,
           is_closed as "isClosed", sf_email_opt_out as "sfEmailOptOut", coalesce(phones, '[]'::jsonb) as phones
    from crm_records
    where org_id = ${orgId}::uuid and ${match}
    order by sf_record_id
    limit 1`);
  const row = rows<Omit<SellerRecord, 'address' | 'phones'> & { email: string | null; phones: unknown }>(result)[0];
  if (!row) return null;
  const { email, phones, ...rest } = row;
  return {
    ...rest,
    address: email !== null && ADDRESS_SHAPE.test(email) ? email : null,
    phones: phonesOf(phones),
  };
}

/** The record's real conversation (never a practice one), with the handling person's name. */
export async function realConversation(db: Db, orgId: string, crmRecordId: string): Promise<ConversationState | null> {
  const result = await db.execute(sql`
    select c.id, c.status, c.stop_reason as "stopReason", c.flag_reason as "flagReason", c.handler,
           case when c.handler = 'person'
                then coalesce(nullif(btrim(u.display_name), ''), nullif(split_part(u.email, '@', 1), '')) end as "handlerName"
    from seller_conversations c
    left join users u on u.id = c.handler_user_id
    where c.org_id = ${orgId}::uuid and c.crm_record_id = ${crmRecordId}::uuid and c.practice_user_id is null`);
  return rows<ConversationState>(result)[0] ?? null;
}

/** What the email blocks depend on beyond the record: whether the server can email at all, and the tenant's settings. */
export interface EmailSetup {
  /** Resend is configured and Sam has a writer. */
  configured: boolean;
  /** `organizations.settings` as stored. */
  settings: unknown;
}

/**
 * What a block is checked for. A `draft` is only shown to the admin, so the tenant's switch (off, or paused after a
 * complaint), which stops sending, does not stop it: an admin may read what Sam would write before turning email on.
 */
export type BlockUse = 'send' | 'draft';

/** Why Sam may not send (or draft, `use`) this seller a first email now, or null when she may (the order: the module comment). */
export async function sellerEmailBlock(
  db: Db,
  setup: EmailSetup,
  i: { orgId: string; record: SellerRecord; conversation: ConversationState | null },
  use: BlockUse = 'send',
): Promise<EmailBlock | null> {
  if (!setup.configured) return 'not_configured';
  const off = use === 'send' ? switchBlock(setup.settings) : null;
  if (off) return off;
  const { record, conversation } = i;
  if (record.address === null) return 'no_address';
  const approved = await hasApprovedPlan(db, i.orgId, record.id);
  // The send tick's own read: an opt-out (suppression, or Email Opt Out on any record with the address) is the address's.
  const address = await addressBlocks(db, i.orgId, record.address);
  return sellerBlock({
    purpose: 'first',
    approved,
    closed: record.isClosed,
    conversationStatus: conversation?.status ?? 'open',
    handler: conversation?.handler ?? 'sam',
    flagReason: conversation?.flagReason ?? null,
    suppressed: address.suppressed,
    sfEmailOptOut: record.sfEmailOptOut || address.sfOptOut,
  });
}

/**
 * Why an admin's practice email (to their own address) may not be drafted or sent: the seller's own blocks do not
 * apply (nothing reaches the seller), the server setup does, the tenant's switch does for a send (`BlockUse`), and the
 * admin needs an address.
 */
export function practiceEmailBlock(setup: EmailSetup, adminAddress: string | null, use: BlockUse = 'send'): EmailBlock | null {
  if (!setup.configured) return 'not_configured';
  return (use === 'send' ? switchBlock(setup.settings) : null) ?? (adminAddress === null ? 'no_address' : null);
}

/** The signed-in person's own address (users.email), trimmed; null when it is blank or not an address. */
export async function ownAddress(db: Db, userId: string): Promise<string | null> {
  const result = await db.execute(sql`select btrim(email) as email from users where id = ${userId}::uuid`);
  const email = rows<{ email: string | null }>(result)[0]?.email ?? null;
  return email !== null && ADDRESS_SHAPE.test(email) ? email : null;
}

/**
 * The seller's page. `isAdmin` decides `mayEmail` (only admins send); `mayChangeHandler` is the caller's (the route
 * has already refused anyone who is neither the record's owner nor an admin).
 */
export async function conversationView(
  db: Db,
  setup: EmailSetup,
  i: { orgId: string; record: SellerRecord; isAdmin: boolean; mayChangeHandler: boolean },
): Promise<ConversationView> {
  const { record } = i;
  const conversation = await realConversation(db, i.orgId, record.id);
  const [emailBlock, items, connection] = await Promise.all([
    sellerEmailBlock(db, setup, { orgId: i.orgId, record, conversation }),
    readTimeline(db, { orgId: i.orgId, crmRecordId: record.id, conversationId: conversation?.id ?? null }),
    loadConnection(db, i.orgId),
  ]);
  return {
    sfRecordId: record.sfRecordId,
    sfObject: record.sfObject,
    name: record.name?.trim() || record.sfRecordId,
    // No Salesforce connection (it was removed) leaves the page without a link rather than failing it.
    recordUrl: connection ? `${connection.instanceUrl.replace(/\/$/, '')}/${record.sfRecordId}` : '',
    conversationId: conversation?.id ?? null,
    handler: conversation?.handler ?? 'sam',
    handlerName: conversation?.handlerName ?? null,
    status: conversation?.status ?? 'open',
    // A stored reason the contract does not know yet reads as none (the columns have no CHECK; a later step may add one).
    stopReason: StopReason.safeParse(conversation?.stopReason).data ?? null,
    flagReason: FlagReason.safeParse(conversation?.flagReason).data ?? null,
    emailAddress: record.address,
    emailBlock,
    mayEmail: i.isAdmin && emailBlock === null,
    mayChangeHandler: i.mayChangeHandler,
    items: forPage(items),
  };
}
