import { describe, expect, it } from 'vitest';
import { decideInbound, type InboundState } from './inbound-decide.js';

/** A plain reply from the seller to an open conversation Sam handles: nothing stands in the way of an answer. */
const base: InboundState = {
  unsubscribeAddress: false,
  autoReply: false,
  optOutText: false,
  senderMatches: true,
  addressBlocked: false,
  practice: false,
  status: 'open',
  recordClosed: false,
  handler: 'sam',
  flagged: false,
  samSentLast24h: 0,
  emailOn: true,
  writerAvailable: true,
};
const decide = (over: Partial<InboundState>) => decideInbound({ ...base, ...over });

describe('decideInbound', () => {
  it('11. otherwise Sam is asked', () => {
    expect(decideInbound(base)).toEqual({ kind: 'ask_sam' });
  });

  it('1. mail to the unsubscribe mailbox opts out', () => {
    expect(decide({ unsubscribeAddress: true })).toEqual({ kind: 'opt_out' });
  });

  it('1 beats 2: an unsubscribe mailto sent by an auto-responder still opts out', () => {
    expect(decide({ unsubscribeAddress: true, autoReply: true })).toEqual({ kind: 'opt_out' });
  });

  it('1 beats everything after it: a stopped, closed, flagged, other-sender reply to the unsubscribe mailbox still opts out', () => {
    expect(decide({ unsubscribeAddress: true, status: 'stopped', senderMatches: false, recordClosed: true, flagged: true, handler: 'person', emailOn: false })).toEqual({ kind: 'opt_out' });
  });

  it('2. an auto-reply is recorded only (never answered, never flagged)', () => {
    expect(decide({ autoReply: true })).toEqual({ kind: 'record_only' });
  });

  it('2 beats 3: an out-of-office that happens to say "unsubscribe" is not an opt-out', () => {
    expect(decide({ autoReply: true, optOutText: true })).toEqual({ kind: 'record_only' });
  });

  it('2 beats the loop guard: an auto-responder never raises a flag', () => {
    expect(decide({ autoReply: true, samSentLast24h: 9 })).toEqual({ kind: 'record_only' });
  });

  it('3. opt-out wording opts out', () => {
    expect(decide({ optOutText: true })).toEqual({ kind: 'opt_out' });
  });

  it('3 beats 4 and 5: opt-out wording from another address, on a stopped conversation, still opts out', () => {
    expect(decide({ optOutText: true, status: 'stopped', senderMatches: false })).toEqual({ kind: 'opt_out' });
  });

  it('4. a stopped conversation records the reply only', () => {
    expect(decide({ status: 'stopped' })).toEqual({ kind: 'record_only' });
  });

  it('4 beats 5: a stopped conversation does not flag another sender', () => {
    expect(decide({ status: 'stopped', senderMatches: false })).toEqual({ kind: 'record_only' });
  });

  it('5. a sender that is not the seller is flagged other_sender', () => {
    expect(decide({ senderMatches: false })).toEqual({ kind: 'flag', reason: 'other_sender' });
  });

  it('5. on a practice conversation a sender that is not the admin is flagged too', () => {
    expect(decide({ practice: true, senderMatches: false })).toEqual({ kind: 'flag', reason: 'other_sender' });
    expect(decide({ practice: true })).toEqual({ kind: 'ask_sam' });
  });

  it('5 beats 6: another sender on a booked conversation is other_sender', () => {
    expect(decide({ senderMatches: false, status: 'booked' })).toEqual({ kind: 'flag', reason: 'other_sender' });
  });

  it('5b. a reply from a suppressed or Salesforce-opted-out address is flagged unsure: the writer is never asked (M4)', () => {
    expect(decide({ addressBlocked: true })).toEqual({ kind: 'flag', reason: 'unsure' });
  });

  it('5b comes after the opt-out, stopped and other-sender rules', () => {
    expect(decide({ addressBlocked: true, unsubscribeAddress: true })).toEqual({ kind: 'opt_out' });
    expect(decide({ addressBlocked: true, autoReply: true })).toEqual({ kind: 'record_only' });
    expect(decide({ addressBlocked: true, optOutText: true })).toEqual({ kind: 'opt_out' });
    expect(decide({ addressBlocked: true, status: 'stopped' })).toEqual({ kind: 'record_only' });
    expect(decide({ addressBlocked: true, senderMatches: false })).toEqual({ kind: 'flag', reason: 'other_sender' });
  });

  it('5b beats everything after it: booked, closed, a person handling, a flag, the loop guard, email off', () => {
    for (const over of [{ status: 'booked' as const }, { recordClosed: true }, { handler: 'person' as const }, { flagged: true }, { samSentLast24h: 9 }, { emailOn: false }]) {
      expect(decide({ addressBlocked: true, ...over }), JSON.stringify(over)).toEqual({ kind: 'flag', reason: 'unsure' });
    }
  });

  it('6. a booked conversation is flagged after_close', () => {
    expect(decide({ status: 'booked' })).toEqual({ kind: 'flag', reason: 'after_close' });
  });

  it('6. a closed record is flagged after_close', () => {
    expect(decide({ recordClosed: true })).toEqual({ kind: 'flag', reason: 'after_close' });
  });

  it('6 beats 7 and 8: a closed record is flagged even when a person handles it or it is already flagged', () => {
    expect(decide({ recordClosed: true, handler: 'person', flagged: true })).toEqual({ kind: 'flag', reason: 'after_close' });
  });

  it('7. a person handling the seller: recorded only', () => {
    expect(decide({ handler: 'person' })).toEqual({ kind: 'record_only' });
  });

  it('7 beats 9: a person handling the seller is never loop-guarded', () => {
    expect(decide({ handler: 'person', samSentLast24h: 5 })).toEqual({ kind: 'record_only' });
  });

  it('8. an already flagged conversation: recorded only', () => {
    expect(decide({ flagged: true })).toEqual({ kind: 'record_only' });
  });

  it('8 beats 9 and 10', () => {
    expect(decide({ flagged: true, samSentLast24h: 3, emailOn: false })).toEqual({ kind: 'record_only' });
  });

  it('9. Sam sent 3 or more in the last 24 hours: flagged loop_guard', () => {
    expect(decide({ samSentLast24h: 2 })).toEqual({ kind: 'ask_sam' });
    expect(decide({ samSentLast24h: 3 })).toEqual({ kind: 'flag', reason: 'loop_guard' });
    expect(decide({ samSentLast24h: 4 })).toEqual({ kind: 'flag', reason: 'loop_guard' });
  });

  it('9 beats 10', () => {
    expect(decide({ samSentLast24h: 3, emailOn: false, writerAvailable: false })).toEqual({ kind: 'flag', reason: 'loop_guard' });
  });

  it('10. email off or no writer: flagged unsure', () => {
    expect(decide({ emailOn: false })).toEqual({ kind: 'flag', reason: 'unsure' });
    expect(decide({ writerAvailable: false })).toEqual({ kind: 'flag', reason: 'unsure' });
  });
});
