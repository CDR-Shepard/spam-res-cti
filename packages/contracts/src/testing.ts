/**
 * Inbound agent testing (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md): an admin keeps
 * a list of test phones; when one of them calls one of the AI phone agent's numbers it gets the agent
 * (with its own editable "inbound" prompt) instead of a rep. outreach-api serves the Testing page's list
 * and recent inbound test calls; cti-api answers the calls. The list also gates outbound test calls.
 */
import { z } from 'zod';

/** At most this many phones on an org's list (a 26th is refused with 400). */
export const TEST_PHONES_MAX = 25;

/** How many of the newest inbound test calls the Testing page lists. */
export const INBOUND_TEST_CALLS_SHOWN = 20;

/** outreach-api routes (admin only). */
export const TESTING_PHONES_PATH = '/api/testing/phones';
export const TESTING_INBOUND_CALLS_PATH = '/api/testing/inbound-calls';

/** One phone on the list. addedByEmail is null when the admin who added it has no email on file. */
export const TestPhone = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  label: z.string(),
  addedByEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type TestPhone = z.infer<typeof TestPhone>;

export const TestPhonesResponse = z.object({ phones: z.array(TestPhone) });
export type TestPhonesResponse = z.infer<typeof TestPhonesResponse>;

/**
 * Add a phone. The number is whatever the admin typed ("(619) 555-0123"): outreach-api turns it into E.164
 * and answers 400 when it is not a number, 409 when it is already on the list.
 */
export const AddTestPhoneRequest = z
  .object({
    phone: z.string().trim().min(1).max(40),
    label: z.string().trim().max(60).default(''),
  })
  .strict();
export type AddTestPhoneRequest = z.infer<typeof AddTestPhoneRequest>;

/** How the agent ends an inbound test call: the status it saves with its save tool. */
export const INBOUND_STATUSES = ['qualified', 'callback', 'disqualified', 'incomplete'] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/** What the inbound prompt asks the agent to save about the caller and the property, in the order the page shows them (free text except urgency_level). */
export const INBOUND_DETAIL_FIELDS = [
  'seller_name',
  'phone_number',
  'email',
  'property_address',
  'location',
  'walkthrough_time',
  'timeline',
  'price_expectation',
  'condition',
  'occupancy',
  'mortgage',
  'decision_maker',
  'motivation',
  'urgency',
  'urgency_level',
  'seller_sentiment',
  'best_callback_time',
  'recommended_next_action',
  'notes',
] as const;

/** How motivated the caller is to sell soon: the agent picks one (anything else is dropped when it saves). */
export const INBOUND_URGENCY_LEVELS = ['high', 'medium', 'low', 'unknown'] as const;
export type InboundUrgencyLevel = (typeof INBOUND_URGENCY_LEVELS)[number];
export type InboundDetailField = (typeof INBOUND_DETAIL_FIELDS)[number];

/** The saved details of one inbound call. Not strict: a row may hold older keys, which a read drops. */
export const InboundCallDetails = z.object({
  status: z.enum(INBOUND_STATUSES).optional(),
  location: z.string().optional(),
  timeline: z.string().optional(),
  price_expectation: z.string().optional(),
  condition: z.string().optional(),
  decision_maker: z.string().optional(),
  urgency: z.string().optional(),
  best_callback_time: z.string().optional(),
  notes: z.string().optional(),
  seller_name: z.string().optional(),
  phone_number: z.string().optional(),
  property_address: z.string().optional(),
  occupancy: z.string().optional(),
  motivation: z.string().optional(),
  urgency_level: z.string().optional(),
  seller_sentiment: z.string().optional(),
  recommended_next_action: z.string().optional(),
  email: z.string().optional(),
  walkthrough_time: z.string().optional(),
  mortgage: z.string().optional(),
});
export type InboundCallDetails = z.infer<typeof InboundCallDetails>;

/** One inbound test call on the Testing page. callerLabel is the list's label for the caller's number. */
export const InboundTestCall = z.object({
  id: z.string().uuid(),
  callerE164: z.string(),
  callerLabel: z.string().nullable(),
  /** The AI number the caller dialed; null when the row never recorded it. */
  aiNumber: z.string().nullable(),
  status: z.string(),
  outcome: z.string().nullable(),
  startedAt: z.string(),
  durationSeconds: z.number().int().nullable(),
  details: InboundCallDetails,
});
export type InboundTestCall = z.infer<typeof InboundTestCall>;

/** aiNumbers: the AI agent's numbers a tester can dial. calls: the newest INBOUND_TEST_CALLS_SHOWN. */
export const InboundTestCallsResponse = z.object({
  aiNumbers: z.array(z.string()),
  calls: z.array(InboundTestCall),
});
export type InboundTestCallsResponse = z.infer<typeof InboundTestCallsResponse>;
