import { PgBoss } from 'pg-boss';
import type { AppConfig } from '../config.js';
import type { QueueDefinition } from './queues.js';

/** The slice of pg-boss the runner depends on, so tests can inject a fake. */
export interface BossLike {
  on(event: 'error', handler: (err: Error) => void): unknown;
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<void>;
  getQueue(name: string): Promise<unknown | null>;
  createQueue(name: string, options?: object): Promise<void>;
}

export interface RunnerLogger {
  error: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

export function createBoss(cfg: AppConfig): PgBoss {
  return new PgBoss({ connectionString: cfg.DATABASE_URL, schema: cfg.PGBOSS_SCHEMA, application_name: 'outreach-api' });
}

const STOP_TIMEOUT_MS = 30_000;

export class JobRunner {
  private started = false;
  constructor(private readonly deps: { boss: BossLike; queues: readonly QueueDefinition[]; log: RunnerLogger }) {}

  async start(): Promise<void> {
    const { boss, log } = this.deps;
    boss.on('error', (err) => log.error({ err: err.message }, 'pg-boss error'));
    await boss.start();
    for (const q of this.deps.queues) {
      if (q.options.deadLetter) await this.ensureQueue(q.options.deadLetter, {});
      await this.ensureQueue(q.name, q.options);
    }
    this.started = true;
    log.info({ queues: this.deps.queues.map((q) => q.name) }, 'job runner started');
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
