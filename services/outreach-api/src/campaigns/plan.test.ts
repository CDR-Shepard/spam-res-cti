import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CampaignPlanResponse } from '@cti/contracts';
import { schema } from '@cti/db';
import { fakeDb } from '../test/harness.js';
import { loadPlan, PLAN_PAGE_SIZE, planCountsQuery, planPageQuery, planPageWhere, toPlanRow, type PlanQueryRow } from './plan.js';

const ORG = 'O1';
const CAMPAIGN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CURSOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** A real query builder with no connection: `.toSQL()` shows exactly what Postgres would run. */
const offline = drizzle.mock({ schema });

describe('planPageQuery SQL', () => {
  it('pins the page, the record join, and both subqueries to the tenant, keyset-paged on enrollment id', () => {
    const { sql, params } = planPageQuery(offline, { orgId: ORG, campaignId: CAMPAIGN, status: 'active', cursor: CURSOR, limit: 51 }).toSQL();
    expect(sql).toContain('from "campaign_enrollments" inner join "crm_records" on ("crm_records"."id" = "campaign_enrollments"."crm_record_id" and "crm_records"."org_id" = "campaign_enrollments"."org_id")');
    expect(sql).toContain('where ("campaign_enrollments"."org_id" = $5 and "campaign_enrollments"."campaign_id" = $6 and "campaign_enrollments"."status" = $7 and "campaign_enrollments"."id" > $8)');
    expect(sql).toContain('order by "campaign_enrollments"."id" asc limit $9');
    // Latest triage of this record, same tenant.
    expect(sql).toContain('(select "record_triage"."result" from "record_triage" where "record_triage"."crm_record_id" = "crm_records"."id" and "record_triage"."org_id" = "crm_records"."org_id" order by "record_triage"."created_at" desc limit 1)');
    // Open touch first, else the latest by seq, same tenant.
    expect(sql).toContain('from "touches" where "touches"."enrollment_id" = "campaign_enrollments"."id" and "touches"."org_id" = "campaign_enrollments"."org_id" order by ("touches"."status" in ($1, $2, $3, $4)) desc, "touches"."seq" desc limit 1)');
    expect(params).toEqual(['planned', 'held', 'queued', 'dialing', ORG, CAMPAIGN, 'active', CURSOR, 51]);
  });

  it('drops the status and cursor predicates when not asked for', () => {
    expect(new PgDialect().sqlToQuery(planPageWhere({ orgId: ORG, campaignId: CAMPAIGN }) as SQL).sql)
      .toBe('("campaign_enrollments"."org_id" = $1 and "campaign_enrollments"."campaign_id" = $2)');
  });

  it('counts per status for the tenant campaign', () => {
    const { sql, params } = planCountsQuery(offline, { orgId: ORG, campaignId: CAMPAIGN }).toSQL();
    expect(sql).toBe('select "status", count(*) from "campaign_enrollments" where ("campaign_enrollments"."org_id" = $1 and "campaign_enrollments"."campaign_id" = $2) group by "campaign_enrollments"."status"');
    expect(params).toEqual([ORG, CAMPAIGN]);
  });
});

const triage = {
  summary: 'Inherited the house; wants a quick sale.', channels: [{ channel: 'sms', reason: '"text me, I work nights"' }], timing: 'after 5pm',
  tags: ['inherited', 'prefers_text'], doNotContact: { category: 'attorney', quote: 'talk to my lawyer' },
};
const audit = [{ rule: 'rule1_live', channel: 'sms', verdict: 'held', detail: 'texting is not live yet' }];

function queryRow(n: number, over: Partial<PlanQueryRow> = {}): PlanQueryRow {
  return {
    enrollmentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'active', exitReason: null, sfRecordId: `00Q${String(n).padStart(15, '0')}`,
    name: `Lead ${n}`, ownerName: 'Rep One', triage: null, nextTouch: null, ...over,
  };
}

describe('toPlanRow', () => {
  it('maps triage without its do-not-contact quote, and the touch with a normalized due time and parsed gate audit', () => {
    const row = toPlanRow(queryRow(1, { triage, nextTouch: { seq: 2, channel: 'rep_call', status: 'planned', dueAt: '2026-10-05T14:00:00+00:00', gateAudit: audit } }));
    expect(row.triage).toEqual({ summary: triage.summary, channels: triage.channels, timing: 'after 5pm', tags: ['inherited', 'prefers_text'] });
    expect(row.triage).not.toHaveProperty('doNotContact');
    expect(row.nextTouch).toEqual({ seq: 2, channel: 'rep_call', status: 'planned', dueAt: '2026-10-05T14:00:00.000Z', gateAudit: audit });
  });

  it.each([
    ['malformed triage JSON shows no triage', { triage: { summary: '' } }, { triage: null }],
    ['an unknown touch channel shows no touch', { nextTouch: { seq: 1, channel: 'fax', status: 'planned', dueAt: '2026-10-05T14:00:00Z', gateAudit: [] } }, { nextTouch: null }],
    ['a malformed gate audit shows as empty', { nextTouch: { seq: 1, channel: 'email', status: 'held', dueAt: '2026-10-05T14:00:00Z', gateAudit: [{ rule: 1 }] } }, { nextTouch: expect.objectContaining({ gateAudit: [] }) }],
  ])('%s', (_label, over, expected) => {
    expect(toPlanRow(queryRow(1, over as Partial<PlanQueryRow>))).toMatchObject(expected);
  });
});

describe('loadPlan', () => {
  it(`returns ${PLAN_PAGE_SIZE} rows and the last one as the cursor when a further row exists, plus per-status counts`, async () => {
    const rows = Array.from({ length: PLAN_PAGE_SIZE + 1 }, (_, i) => queryRow(i + 1));
    const { db, captured } = fakeDb({ selectResults: [rows, [{ status: 'active', count: 49 }, { status: 'exited', count: 2 }]] });
    const plan = CampaignPlanResponse.parse(await loadPlan(db, { orgId: ORG, campaignId: CAMPAIGN, cursor: CURSOR }));
    expect(plan.rows).toHaveLength(PLAN_PAGE_SIZE);
    expect(plan.nextCursor).toBe(rows[PLAN_PAGE_SIZE - 1]!.enrollmentId);
    expect(plan.counts).toEqual({ active: 49, exited: 2 });
    expect(new PgDialect().sqlToQuery(captured.where[0] as SQL).sql).toContain('"campaign_enrollments"."id" > $3');
  });

  it('has no cursor on the last page', async () => {
    const { db } = fakeDb({ selectResults: [[queryRow(1)], []] });
    expect(await loadPlan(db, { orgId: ORG, campaignId: CAMPAIGN })).toMatchObject({ nextCursor: null, counts: {} });
  });
});
