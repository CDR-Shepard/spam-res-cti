import { SalesforceApiError } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { readChatter } from './chatter.js';
import type { LinkIds } from './related.js';

const LEAD = '00Q000000000001AAA';
const OPP = '006000000000001AAA';
const links: LinkIds = { whoIds: [LEAD], whatIds: [OPP], parentIds: [LEAD, OPP] };
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T10:00:00.000+0000`;
const post = (n: number, extra: Record<string, unknown> = {}) => ({
  Id: `0D5${String(n).padStart(12, '0')}AAA`,
  ParentId: LEAD,
  Type: 'TextPost',
  Body: `<p>Post ${n}</p>`,
  Title: null,
  LinkUrl: null,
  CreatedDate: day(n),
  CreatedBy: { Name: 'Rep Ann' },
  CommentCount: 0,
  ...extra,
});
const comment = (n: number, feedItem: string) => ({ Id: `0D7${String(n).padStart(12, '0')}AAA`, FeedItemId: feedItem, CommentBody: `<p>Comment ${n}</p>`, CreatedDate: day(n), CreatedBy: { Name: 'Rep Bo' } });

describe('readChatter posts', () => {
  it('queries FeedItem, turns rich text into plain text, carries author and type', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, [post(1, { Body: '<p>Roof&nbsp;leaks</p>', Type: 'LinkPost' })]]] });
    const { posts, comments } = await readChatter(sf.client, links);
    expect(sf.soql[0]).toBe(
      `SELECT Id, ParentId, Type, Body, Title, LinkUrl, CreatedDate, CreatedBy.Name, CommentCount FROM FeedItem WHERE ParentId IN ('${LEAD}', '${OPP}') ORDER BY CreatedDate DESC, Id DESC LIMIT 26`,
    );
    expect(posts.items[0]).toMatchObject({ source: 'chatter', body: 'Roof leaks', at: day(1), meta: { author: 'Rep Ann', type: 'LinkPost' } });
    expect(posts.summary).toEqual({ source: 'chatter', status: 'ok', count: 1, truncated: false, note: null });
    expect(comments.summary).toMatchObject({ source: 'chatter_comments', status: 'ok', count: 0 });
  });

  it('clips the body at 1,500, keeps title-only posts and drops empty ones', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM FeedItem/, [post(1, { Body: 'z'.repeat(1_800) }), post(2, { Body: null, Title: 'Offer letter' }), post(3, { Body: '<p> </p>' })]]],
    });
    const { posts } = await readChatter(sf.client, links);
    expect(posts.items.map((i) => i.title)).toEqual([null, 'Offer letter']);
    expect(posts.items[0]?.body).toHaveLength(1_501);
  });

  it('26 rows keep 25 and say truncated', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, Array.from({ length: 26 }, (_, i) => post(i + 1))]] });
    const { posts } = await readChatter(sf.client, links);
    expect(posts.items).toHaveLength(25);
    expect(posts.summary.truncated).toBe(true);
  });

  it('an author-less row reads as unknown', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, [post(1, { CreatedBy: null })]]] });
    expect((await readChatter(sf.client, links)).posts.items[0]?.meta.author).toBe('unknown');
  });
});

describe('readChatter comments', () => {
  it('reads comments only for posts that have some, 50 at most, clipped at 600', async () => {
    const a = post(1, { CommentCount: 2 });
    const b = post(2, { CommentCount: 0 });
    const rows = Array.from({ length: 51 }, (_, i) => ({ ...comment(i + 1, a.Id), CommentBody: 'c'.repeat(700) }));
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, [a, b]], [/FROM FeedComment/, rows]] });
    const { comments } = await readChatter(sf.client, links);
    expect(sf.soql[1]).toBe(
      `SELECT Id, FeedItemId, CommentBody, CreatedDate, CreatedBy.Name FROM FeedComment WHERE FeedItemId IN ('${a.Id}') ORDER BY CreatedDate DESC LIMIT 51`,
    );
    expect(comments.items).toHaveLength(50);
    expect(comments.summary).toMatchObject({ status: 'ok', count: 50, truncated: true });
    expect(comments.items[0]).toMatchObject({ source: 'chatter_comment', title: null, meta: { author: 'Rep Bo', post: a.Id } });
    expect(comments.items[0]?.body).toHaveLength(601);
  });

  it('no post with comments: no FeedComment query', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, [post(1)]]] });
    const { comments } = await readChatter(sf.client, links);
    expect(sf.soql).toHaveLength(1);
    expect(comments.summary).toMatchObject({ status: 'ok', count: 0 });
  });

  it('a post id that is not a Salesforce id is never put in the comment query', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, [post(1, { Id: "x' OR '1'='1", CommentCount: 3 })]]] });
    const { comments } = await readChatter(sf.client, links);
    expect(sf.soql).toHaveLength(1);
    expect(comments.summary.count).toBe(0);
  });
});

describe('readChatter degradation', () => {
  it('Chatter disabled (INVALID_TYPE): posts missing, comments skipped with a note', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, new SalesforceApiError('x', 400, [{ errorCode: 'INVALID_TYPE', message: 'FeedItem' }])]] });
    const { posts, comments } = await readChatter(sf.client, links);
    expect(posts.summary).toEqual({ source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' });
    expect(comments.summary).toEqual({ source: 'chatter_comments', status: 'skipped', count: 0, truncated: false, note: 'no posts' });
    expect(sf.soql).toHaveLength(1);
  });

  it('comments denied while posts are fine is recorded, not thrown', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM FeedItem/, [post(1, { CommentCount: 1 })]], [/FROM FeedComment/, new SalesforceApiError('x', 403, [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'x' }])]],
    });
    const { posts, comments } = await readChatter(sf.client, links);
    expect(posts.items).toHaveLength(1);
    expect(comments.summary).toMatchObject({ status: 'denied', note: 'INSUFFICIENT_ACCESS' });
  });

  it('an outage throws', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM FeedItem/, new SalesforceApiError('down', 503, null)]] });
    await expect(readChatter(sf.client, links)).rejects.toThrow('down');
  });
});
