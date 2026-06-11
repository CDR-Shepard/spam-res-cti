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
    | 'did_auto_paused'
    | 'analytics_block_detected'
    | 'attestation_degraded'
    | 'org_reputation_dropped';
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

  const cfg = loadConfig();
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
    logger.error({ err: (err as Error).message, url: cfg.ALERT_WEBHOOK_URL }, 'alert webhook delivery failed');
  }
}
