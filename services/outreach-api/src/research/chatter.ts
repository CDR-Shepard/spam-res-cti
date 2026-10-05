/** Chatter on the lead and its related records: posts (FeedItem) and their comments (FeedComment). */
import type { SalesforceClient } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import type { ActivityItem } from './activity.js';
import { RESEARCH_LIMITS as L } from './limits.js';
import type { LinkIds } from './related.js';
import { readSource, skippedSource, type SourceRead } from './salesforce-errors.js';
import { clip, plainText, soqlIdList } from './text.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const authorOf = (r: Row): string => str((r.CreatedBy as Row | null | undefined)?.Name) ?? 'unknown';

export async function readChatter(client: SalesforceClient, links: LinkIds): Promise<{ posts: SourceRead<ActivityItem>; comments: SourceRead<ActivityItem> }> {
  const withComments: string[] = [];
  const posts = await readSource('chatter', async () => {
    if (!links.parentIds.length) return { items: [], truncated: false };
    const rows = await client.query<Row>(
      `SELECT Id, ParentId, Type, Body, Title, LinkUrl, CreatedDate, CreatedBy.Name, CommentCount FROM FeedItem WHERE ParentId IN (${soqlIdList(links.parentIds)}) ORDER BY CreatedDate DESC, Id DESC LIMIT ${L.feedItems + 1}`,
    );
    const kept = rows.slice(0, L.feedItems);
    for (const r of kept) if (typeof r.Id === 'string' && SF_ID.test(r.Id) && Number(r.CommentCount ?? 0) > 0) withComments.push(r.Id);
    const items = kept.flatMap((r): ActivityItem[] => {
      const body = plainText(str(r.Body) ?? '');
      const title = str(r.Title);
      if (!body && !title) return [];
      return [{ source: 'chatter', id: String(r.Id), at: str(r.CreatedDate), title, body: clip(body, L.feedChars).text, meta: { author: authorOf(r), type: str(r.Type) ?? 'TextPost' } }];
    });
    return { items, truncated: rows.length > L.feedItems };
  });
  if (posts.summary.status !== 'ok') return { posts, comments: { items: [], summary: skippedSource('chatter_comments', 'no posts') } };
  const comments = await readSource('chatter_comments', async () => {
    if (!withComments.length) return { items: [], truncated: false };
    const rows = await client.query<Row>(
      `SELECT Id, FeedItemId, CommentBody, CreatedDate, CreatedBy.Name FROM FeedComment WHERE FeedItemId IN (${soqlIdList(withComments)}) ORDER BY CreatedDate DESC LIMIT ${L.feedComments + 1}`,
    );
    return {
      truncated: rows.length > L.feedComments,
      items: rows.slice(0, L.feedComments).map((r) => ({
        source: 'chatter_comment' as const,
        id: String(r.Id),
        at: str(r.CreatedDate),
        title: null,
        body: clip(plainText(str(r.CommentBody) ?? ''), L.commentChars).text,
        meta: { author: authorOf(r), post: String(r.FeedItemId) },
      })),
    };
  });
  return { posts, comments };
}
