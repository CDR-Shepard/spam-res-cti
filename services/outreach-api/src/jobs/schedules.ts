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
  { queue: 'call.prepare', cron: '* * * * *' },
  { queue: 'ai_call.place', cron: '* * * * *' },
  { queue: 'ai_call.results', cron: '* * * * *' },
  { queue: 'ai_call.writeback', cron: '* * * * *' },
  // The events tick answers at most 3 replies a run, so every minute (180 an hour).
  { queue: 'email.send', cron: '* * * * *' },
  { queue: 'email.events', cron: '* * * * *' },
  { queue: 'conversation.sflog', cron: '* * * * *' },
];
