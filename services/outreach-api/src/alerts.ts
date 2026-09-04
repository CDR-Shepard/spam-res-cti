/**
 * Minimal, pluggable alert dispatcher.
 *
 * Reputation degradation and attestation downgrades are useless if nobody sees
 * them until they open the dashboard. This emits a structured alert to the
 * server log always, and POSTs to ALERT_WEBHOOK_URL (Slack-compatible) when
 * configured. It NEVER throws — alerting must not break a call flow or a worker
 * tick.
 */
import { loadConfig } from './config.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertEvent {
  kind:
    | 'provisioning_failed'
    | 'job_dead_lettered'
    | 'auth_failure_spike';
  severity: AlertSeverity;
  orgId: string;
  /** Human-readable summary line. */
  message: string;
  /** Structured context (DID, scores, reasons, ...). */
  context?: Record<string, unknown>;
}

interface AlertLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export async function dispatchAlert(logger: AlertLogger, event: AlertEvent): Promise<void> {
  const logFn = event.severity === 'info' ? logger.info : logger.warn;
  logFn({ alert: event.kind, orgId: event.orgId, ...event.context }, `alert: ${event.message}`);

  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'alert webhook config invalid; skipping webhook delivery');
    return;
  }
  if (!cfg.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(cfg.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${event.severity.toUpperCase()}] ${event.message}`,
        kind: event.kind,
        orgId: event.orgId,
        context: event.context ?? {},
      }),
    });
  } catch (err) {
    // Host only, never the full URL — it may carry a webhook token/path secret.
    logger.error({ err: (err as Error).message, host: new URL(cfg.ALERT_WEBHOOK_URL).host }, 'alert webhook delivery failed');
  }
}
