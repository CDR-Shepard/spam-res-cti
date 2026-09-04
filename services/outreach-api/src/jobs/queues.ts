/** Every pg-boss queue this service owns. Queues are created idempotently on boot. */
export interface QueueOptions {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  deadLetter?: string;
}
export interface QueueDefinition {
  name: string;
  options: QueueOptions;
}
/** Plan 3 (lead store + import pipeline) adds `import.*` and `delivery.send` here. */
export const QUEUES: readonly QueueDefinition[] = [];
