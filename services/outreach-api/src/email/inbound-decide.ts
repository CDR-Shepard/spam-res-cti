/**
 * What to do with a seller's reply, from facts already read: record it, stop the seller, hand it to a person, or
 * ask Sam. Pure, so the order of the rules is the whole policy and a test pins each one.
 *
 * The order is the point. An opt-out is honoured before anything else can swallow it (the unsubscribe mailbox even
 * when an auto-responder wrote to it, because a mail client's List-Unsubscribe mailto can look automatic); an
 * auto-reply is never answered and never raises a flag (an out-of-office must not start a mail loop or page a
 * person); a stopped seller is never written to again; and only then come the reasons a person must look (someone
 * other than the seller, an address Sam may not email, a booked or closed seller, the 3-a-day loop guard, Sam's
 * email not available). A seller a person already handles, or one already flagged, is recorded only: the person has
 * it. A reply from an address that is suppressed or opted out in Salesforce never reaches Sam's writer: she could
 * not send her answer anyway, and the seller's words must not be dropped silently.
 */
import type { ConversationHandler, ConversationStatus, FlagReason } from '@cti/contracts';

/** The loop guard: this many of Sam's emails out in the last 24 hours and the next reply goes to a person (the same 3 as the send tick's daily cap, outbox.ts). */
export const LOOP_GUARD_EMAILS = 3;

export interface InboundState {
  /** The reply was sent to the conversation's `unsubscribe+<token>` mailbox. */
  unsubscribeAddress: boolean;
  /** Machine-sent (out-of-office, bounce, list mail): inbound-text.ts isAutoReply. */
  autoReply: boolean;
  /** The reply asks to stop (the whole reply read, quoted lines and our footer left out). */
  optOutText: boolean;
  /** The From address is the seller's (the record's email), or for a practice conversation the admin's. */
  senderMatches: boolean;
  /**
   * The From address is suppressed in this tenant, or Salesforce Email Opt Out is set on any record with it (the send
   * tick's own reads, outbox.ts addressBlocks). Always false on a practice conversation (the admin's own address).
   */
  addressBlocked: boolean;
  /** An admin's practice conversation. */
  practice: boolean;
  status: ConversationStatus;
  /** Salesforce says the record is closed (crm_records.is_closed). */
  recordClosed: boolean;
  handler: ConversationHandler;
  /** A flag is already waiting for a person. */
  flagged: boolean;
  /** Sam's emails on this conversation that went out (or are going) in the last 24 hours. */
  samSentLast24h: number;
  /** Sam's email is configured, switched on for the tenant and not paused. */
  emailOn: boolean;
  /** Sam's writer is configured. */
  writerAvailable: boolean;
}

export type InboundDecision = { kind: 'record_only' } | { kind: 'opt_out' } | { kind: 'flag'; reason: FlagReason } | { kind: 'ask_sam' };

const RECORD_ONLY: InboundDecision = { kind: 'record_only' };
const OPT_OUT: InboundDecision = { kind: 'opt_out' };
const flag = (reason: FlagReason): InboundDecision => ({ kind: 'flag', reason });

/** The first rule that applies wins (see the module comment for why this order). */
export function decideInbound(s: InboundState): InboundDecision {
  if (s.unsubscribeAddress) return OPT_OUT;
  if (s.autoReply) return RECORD_ONLY;
  if (s.optOutText) return OPT_OUT;
  if (s.status === 'stopped') return RECORD_ONLY;
  if (!s.senderMatches) return flag('other_sender');
  if (s.addressBlocked) return flag('unsure');
  if (s.status === 'booked' || s.recordClosed) return flag('after_close');
  if (s.handler === 'person') return RECORD_ONLY;
  if (s.flagged) return RECORD_ONLY;
  if (s.samSentLast24h >= LOOP_GUARD_EMAILS) return flag('loop_guard');
  if (!s.emailOn || !s.writerAvailable) return flag('unsure');
  return { kind: 'ask_sam' };
}
