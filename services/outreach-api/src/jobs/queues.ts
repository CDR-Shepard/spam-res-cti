/** Every pg-boss queue this service owns. Queues are created idempotently on boot. */
export interface QueueOptions {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  deadLetter?: string;
  /**
   * pg-boss queue policy; fixed when the queue is created. `stately` allows one queued and
   * one active job at a time, so a scheduled tick never runs twice at once and a slow tick
   * never builds a backlog of ticks.
   */
  policy?: 'singleton' | 'stately';
}
export interface QueueDefinition {
  name: string;
  options: QueueOptions;
}

/**
 * Scheduled ticks: durable state lives in our tables, so a failed tick is not retried —
 * the next tick picks up the same rows.
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
];
