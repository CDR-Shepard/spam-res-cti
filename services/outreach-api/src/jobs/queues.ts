/** Every pg-boss queue this service owns. Queues are created idempotently on boot. */
export interface QueueOptions {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  deadLetter?: string;
  /**
   * pg-boss queue policy; fixed when the queue is created. `stately` allows one queued and
   * one active job at a time, so a slow tick never builds a backlog of ticks. It does NOT
   * guarantee a handler is never running twice: pg-boss marks a job failed at
   * `expireInSeconds` but cannot stop the handler, so the next tick may start while the
   * previous handler is still working. A tick that must not overlap itself claims its rows
   * in the database (`campaign.refresh` uses `campaigns.refresh_started_at`).
   */
  policy?: 'singleton' | 'stately';
}
export interface QueueDefinition {
  name: string;
  options: QueueOptions;
}

/**
 * Scheduled ticks: durable state lives in our tables, so a failed tick is not retried —
 * the next tick picks up the same rows. A tick handler should stop starting new work well
 * before `expireInSeconds` and claim its rows (see `stately` above).
 */
export const TICK_QUEUE_OPTIONS: QueueOptions = {
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: 900,
  policy: 'stately',
};

export const QUEUES: readonly QueueDefinition[] = [
  { name: 'campaign.refresh', options: TICK_QUEUE_OPTIONS },
  { name: 'record.triage', options: TICK_QUEUE_OPTIONS },
  { name: 'touch.plan', options: TICK_QUEUE_OPTIONS },
  { name: 'call.prepare', options: TICK_QUEUE_OPTIONS },
  { name: 'ai_call.place', options: TICK_QUEUE_OPTIONS },
  { name: 'ai_call.results', options: TICK_QUEUE_OPTIONS },
  // Plan 1D: each counted AI call's result written to Salesforce (claims its rows with a lease; see writeback/run.ts).
  { name: 'ai_call.writeback', options: TICK_QUEUE_OPTIONS },
  // Sam's email: the outbox drained through Resend (claims each row by compare-and-swap; see email/send.ts) and the
  // stored Resend webhook events processed, replies answered (claims with a lease; see email/events.ts).
  { name: 'email.send', options: TICK_QUEUE_OPTIONS },
  { name: 'email.events', options: TICK_QUEUE_OPTIONS },
  // Timeline events logged to Salesforce as Tasks. Two ticks must not run at once on one seller (a Task one tick just
  // made must already be owned when the next looks): `stately` keeps one tick active until the 900 s expiry, and
  // each event's lease is renewed before its work (conversations/sf-log.ts).
  { name: 'conversation.sflog', options: TICK_QUEUE_OPTIONS },
];
