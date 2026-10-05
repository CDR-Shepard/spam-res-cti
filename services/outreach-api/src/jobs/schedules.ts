/**
 * Cron schedules (UTC) for the tick queues in `queues.ts`. Each tick finds its own due
 * work: `campaign.refresh` refreshes the campaigns whose `refresh_minutes` have passed.
 */
export interface ScheduleDefinition {
  queue: string;
  cron: string;
}

export const SCHEDULES: readonly ScheduleDefinition[] = [
  { queue: 'campaign.refresh', cron: '*/5 * * * *' },
  { queue: 'record.triage', cron: '* * * * *' },
  { queue: 'touch.plan', cron: '* * * * *' },
];
