import { describe, expect, it } from 'vitest';
import { ConversationHandler, ConversationStatus, EmailStatus } from '@cti/contracts';
import { schema } from '@cti/db';

/**
 * The store writes the handler and status values the contracts name into columns whose CHECKs list them
 * (migration 0062). The two lists live in two packages; this pins them together so a value added to one
 * is caught here rather than by a failing INSERT in production.
 */
describe('conversation enums match the table CHECK lists', () => {
  it('handler', () => {
    expect([...ConversationHandler.options]).toEqual([...schema.CONVERSATION_HANDLERS]);
  });

  it('status', () => {
    expect([...ConversationStatus.options]).toEqual([...schema.CONVERSATION_STATUSES]);
  });

  it('email status', () => {
    expect([...EmailStatus.options]).toEqual([...schema.EMAIL_STATUSES]);
  });
});
