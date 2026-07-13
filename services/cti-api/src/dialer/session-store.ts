import { schema } from '../db/index.js';

export type DialerItem = typeof schema.dialerQueueItems.$inferSelect;

export function sessionCounts(items: Array<Pick<DialerItem, 'status'>>): {
  total: number; done: number; connected: number; noConnect: number;
  skipped: number; unreachable: number; pending: number;
} {
  const c = { total: items.length, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 };
  for (const it of items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'connected') c.connected++;
    else if (it.status === 'no_connect') c.noConnect++;
    else if (it.status === 'skipped') c.skipped++;
    else if (it.status === 'unreachable') c.unreachable++;
    else if (it.status === 'pending') c.pending++;
  }
  return c;
}
