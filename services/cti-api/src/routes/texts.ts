/**
 * The rep's texts, for the softphone's Texts tab.
 *
 *  GET /texts?limit=50          → the signed-in rep's texts, newest first, each
 *                                 named from its Salesforce Task
 *  GET /texts/new?since=<ISO>   → how many arrived after `since` (the tab's badge)
 *
 * Both only ever read the signed-in rep's own rows. The badge count is a
 * database read only, so polling it costs Salesforce nothing.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveSession } from '@cti/auth';
import { getDb, type InboundMessage } from '@cti/db';
import {
  countRepTextsSince,
  fetchTaskLinks,
  selectRepTexts,
  textListItem,
  type TaskLinkInfo,
} from '../sms/text-list.js';

export interface TextRouteDeps {
  listTexts: (userId: string, limit: number) => Promise<InboundMessage[]>;
  countSince: (userId: string, since: Date) => Promise<number>;
  taskLinks: (userId: string, taskIds: string[]) => Promise<Map<string, TaskLinkInfo>>;
}

export const DEFAULT_TEXT_LIMIT = 50;
export const MAX_TEXT_LIMIT = 100;

function liveTextDeps(): TextRouteDeps {
  return {
    listTexts: (userId, limit) => selectRepTexts(getDb(), userId, limit),
    countSince: async (userId, since) => (await countRepTextsSince(getDb(), userId, since))[0]?.n ?? 0,
    taskLinks: (userId, taskIds) => fetchTaskLinks(userId, taskIds),
  };
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_TEXT_LIMIT).default(DEFAULT_TEXT_LIMIT),
});

const newQuery = z.object({ since: z.string().datetime({ offset: true }) });

export async function registerTextRoutes(app: FastifyInstance, deps?: TextRouteDeps): Promise<void> {
  const d = (): TextRouteDeps => deps ?? liveTextDeps();

  app.get('/texts', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const q = listQuery.safeParse(req.query);
    const limit = q.success ? q.data.limit : DEFAULT_TEXT_LIMIT;
    const rows = await d().listTexts(session.userId, limit);
    const taskIds = rows.flatMap((r) => (r.sfTaskId ? [r.sfTaskId] : []));
    let tasks = new Map<string, TaskLinkInfo>();
    let tasksKnown = true;
    if (taskIds.length > 0) {
      try {
        tasks = await d().taskLinks(session.userId, taskIds);
      } catch (err) {
        // The texts still show, by number; a tap opens the Task itself.
        tasksKnown = false;
        req.log.warn({ err: (err as Error).message }, 'texts: Salesforce Task lookup failed; listing without names');
      }
    }
    return { texts: rows.map((r) => textListItem(r, r.sfTaskId ? tasks.get(r.sfTaskId) : undefined, tasksKnown)) };
  });

  app.get('/texts/new', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const q = newQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'since must be an ISO date-time' });
    return { count: await d().countSince(session.userId, new Date(q.data.since)) };
  });
}
