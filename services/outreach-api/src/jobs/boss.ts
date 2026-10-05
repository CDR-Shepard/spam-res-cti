import { PgBoss } from 'pg-boss';
import type { AppConfig } from '../config.js';
import type { QueueDefinition } from './queues.js';
import type { ScheduleDefinition } from './schedules.js';

/** The slice of pg-boss the runner depends on, so tests can inject a fake. */
export interface BossLike {
  on(event: 'error', handler: (err: Error) => void): unknown;
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  getQueue(name: string): Promise<unknown | null>;
  createQueue(name: string, options?: object): Promise<void>;
  work(name: string, handler: (jobs: unknown[]) => Promise<void>): Promise<string>;
  schedule(name: string, cron: string): Promise<void>;
}

export interface RunnerLogger {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** A tick: finds its own due rows and does the work. Takes no job payload. */
export type JobHandler = () => Promise<void>;

export function createBoss(cfg: AppConfig): PgBoss {
  return new PgBoss({ connectionString: cfg.DATABASE_URL, schema: cfg.PGBOSS_SCHEMA, application_name: 'outreach-api' });
}

const STOP_TIMEOUT_MS = 30_000;

export class JobRunner {
  private started = false;
  constructor(
    private readonly deps: {
      boss: BossLike;
      queues: readonly QueueDefinition[];
      log: RunnerLogger;
      /** One worker per entry, keyed by queue name. */
      handlers?: Readonly<Record<string, JobHandler>>;
      /** Cron schedules. One whose queue has no handler is skipped (its feature is not configured). */
      schedules?: readonly ScheduleDefinition[];
    },
  ) {}

  async start(): Promise<void> {
    const { boss, log } = this.deps;
    boss.on('error', (err) => log.error({ err: err.message }, 'pg-boss error'));
    await boss.start();
    for (const q of this.deps.queues) {
      if (q.options.deadLetter) await this.ensureQueue(q.options.deadLetter, {});
      await this.ensureQueue(q.name, q.options);
    }
    const handlers = this.deps.handlers ?? {};
    for (const [name, handler] of Object.entries(handlers)) {
      await boss.work(name, () => this.runSafely(name, handler));
    }
    const schedules = (this.deps.schedules ?? []).filter((s) => s.queue in handlers);
    for (const s of schedules) await boss.schedule(s.queue, s.cron);
    this.started = true;
    log.info(
      { queues: this.deps.queues.map((q) => q.name), workers: Object.keys(handlers), schedules: schedules.map((s) => s.queue) },
      'job runner started',
    );
  }

  /** A tick that throws is logged and swallowed: pg-boss records the job as completed, the next tick retries the work. */
  private async runSafely(name: string, handler: JobHandler): Promise<void> {
    try {
      await handler();
    } catch (err) {
      this.deps.log.error({ queue: name, err: err instanceof Error ? err.message : String(err) }, 'job handler failed');
    }
  }

  private async ensureQueue(name: string, options: object): Promise<void> {
    if (await this.deps.boss.getQueue(name)) return;
    await this.deps.boss.createQueue(name, options);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.deps.boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
  }

  isHealthy(): boolean {
    return this.started;
  }
}
