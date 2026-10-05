import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallPlanCard, CallPlansResponse, EditableCallPlan } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { campaign, CAMPAIGN_ID } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { CallPlanBoard } from './call-plan-board';

afterEach(() => vi.unstubAllGlobals());

const BOARD = `/api/campaigns/${CAMPAIGN_ID}/call-plans`;
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const PLAN: EditableCallPlan = {
  situationSummary: 'Inherited the house in 2024 and the roof leaks.',
  sellingSignals: [{ signal: 'Wants a quick sale', evidence: 'we need this done before winter', source: 'task', strength: 'strong' }],
  opener: 'Ask whether the family has decided about the house.',
  goals: [
    { goal: 'still_selling', known: 'Open to selling in May', approach: 'Ask if that is still the plan' },
    { goal: 'timeline', known: null, approach: 'Ask when they would want to be done' },
    { goal: 'condition', known: 'Roof leaks', approach: 'Ask if the roof was fixed' },
    { goal: 'price_expectations', known: null, approach: 'Ask for a number; never give one' },
  ],
  talkingPoints: ['We buy as-is'],
  questions: ['Is everyone on the title on board?'],
  avoid: ['Do not mention the attorney'],
  bestTimeToCall: { window: 'evening', reason: 'Works days' },
};

function card(n: number, over: Partial<CallPlanCard> = {}): CallPlanCard {
  return {
    enrollmentId: ID(n),
    sfObject: 'Lead',
    sfRecordId: `00Q00000000000${n}AAA`,
    recordUrl: `https://gghomes.my.salesforce.com/00Q00000000000${n}AAA`,
    name: `Lead ${n}`,
    ownerName: 'Rep One',
    enrollmentStatus: 'active',
    callStage: 'review',
    consent: 'yes',
    warnings: [],
    research: { version: 1, collectedAt: '2026-10-05T10:00:00.000Z', sources: [{ source: 'record', status: 'ok', count: 1, truncated: false, note: null }, { source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' }] },
    plan: { version: 1, status: 'proposed', source: 'model', plan: PLAN, createdAt: '2026-10-05T10:00:00.000Z', decidedAt: null, dncFlagDismissed: false, dncFlagDismissedBy: null, dncFlagDismissedAt: null },
    prepareError: null,
    mayDecide: true,
    ...over,
  };
}
const approvedCard = (n: number) => card(n, { callStage: 'approved', plan: { ...card(n).plan!, status: 'approved', decidedAt: '2026-10-05T11:00:00.000Z' } });
const researchCard = (n: number) => card(n, { callStage: 'research', consent: null, research: null, plan: null });

function board(cards: CallPlanCard[], counts: Partial<CallPlansResponse['counts']> = {}, nextCursor: string | null = null): CallPlansResponse {
  return { cards, nextCursor, counts: { research: 0, review: 0, approved: 0, queued: 0, done: 0, ...counts } };
}
const standard = () => board([card(1), approvedCard(2), researchCard(3)], { research: 1, review: 1, approved: 1 });
const render = (opts: { status?: 'active' | 'dry_run'; isAdmin?: boolean } = {}) =>
  renderWithProviders(<CallPlanBoard campaign={campaign({ id: CAMPAIGN_ID, mode: 'ai_call', status: opts.status ?? 'active' })} isAdmin={opts.isAdmin ?? true} />, { isAdmin: opts.isAdmin ?? true });
const cardOf = async (name: string) => (await screen.findByRole('link', { name })).closest('[data-slot="card"]') as HTMLElement;

describe('CallPlanBoard', () => {
  it('1: the counts row reads one count per stage', async () => {
    stubApi({ [`GET ${BOARD}`]: standard() });
    render();
    expect(await screen.findByText('1 researching · 1 waiting for review · 1 approved · 0 queued')).toBeInTheDocument();
  });

  it('2: a review card shows the record link, summary, signals with quoted evidence, the four goals and the sources', async () => {
    stubApi({ [`GET ${BOARD}`]: standard() });
    render();
    const link = await screen.findByRole('link', { name: 'Lead 1' });
    expect(link).toHaveAttribute('href', 'https://gghomes.my.salesforce.com/00Q000000000001AAA');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    const c = within(await cardOf('Lead 1'));
    expect(c.getByText('Inherited the house in 2024 and the roof leaks.')).toBeInTheDocument();
    expect(c.getByText('Wants a quick sale')).toBeInTheDocument();
    expect(c.getByText('we need this done before winter').tagName).toBe('Q');
    for (const goal of ['Still selling?', 'Timeline', 'Condition of the house', 'Their price in mind']) expect(c.getByText(goal)).toBeInTheDocument();
    expect(c.getByText('Ask whether the family has decided about the house.')).toBeInTheDocument();
    expect(c.getByText('Record: 1')).toBeInTheDocument();
    expect(c.getByText('Chatter: not available in this org')).toBeInTheDocument();
    expect(c.getByText('AI consent: yes')).toBeInTheDocument();
  });

  it("3: a card with no AI consent shows the alert and cannot be approved", async () => {
    const words = "Can't call: no AI consent in Salesforce.";
    stubApi({ [`GET ${BOARD}`]: board([card(1, { consent: 'no', warnings: [{ code: 'no_ai_consent', severity: 'block', words }] })], { review: 1 }) });
    render();
    const c = within(await cardOf('Lead 1'));
    expect(c.getByRole('alert')).toHaveTextContent(words);
    expect(c.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('3b (CF-5): consent that could not be read says to research again and cannot be approved', async () => {
    stubApi({ [`GET ${BOARD}`]: board([card(1, { consent: 'unknown', warnings: [{ code: 'consent_unknown', severity: 'block', words: "Can't call: consent could not be read — research again." }] })], { review: 1 }) });
    render();
    const c = within(await cardOf('Lead 1'));
    expect(c.getByText('AI consent: could not be read — research again')).toBeInTheDocument();
    expect(c.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(c.getByRole('button', { name: 'Research again' })).toBeEnabled();
  });

  it('3c (CF-10): a card with no consent reading, or held in Needs Review, explains why it cannot be approved', async () => {
    stubApi({
      [`GET ${BOARD}`]: board([card(1, { consent: null }), card(2, { enrollmentStatus: 'needs_review', warnings: [{ code: 'dnc_pending', severity: 'block', words: "Can't call: a do-not-contact flag on this person is waiting in Needs Review." }] })], { review: 2 }),
    });
    render();
    const one = within(await cardOf('Lead 1'));
    expect(one.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(one.getByText('AI consent has not been read yet. Research again to read it.')).toBeInTheDocument();
    const two = within(await cardOf('Lead 2'));
    expect(two.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(two.getByRole('alert')).toHaveTextContent('waiting in Needs Review');
    expect(two.getByText('Held in Needs Review for a do-not-contact flag; decide it there first.')).toBeInTheDocument();
  });

  it('3d (CF-7): a dismissed do-not-contact flag is shown with who and when; approving stays allowed', async () => {
    const plan = { ...card(1).plan!, dncFlagDismissed: true, dncFlagDismissedBy: 'Rita Rep', dncFlagDismissedAt: '2026-10-05T12:00:00.000Z' };
    stubApi({ [`GET ${BOARD}`]: board([card(1, { plan })], { review: 1 }) });
    render();
    const c = within(await cardOf('Lead 1'));
    expect(c.getByRole('status')).toHaveTextContent(/Do-not-contact flag dismissed by Rita Rep on Oct 5, 2026/);
    expect(c.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('3e (CF-7): a dismissal nobody recorded still says a person dismissed it', async () => {
    const plan = { ...card(1).plan!, dncFlagDismissed: true };
    stubApi({ [`GET ${BOARD}`]: board([card(1, { plan })], { review: 1 }) });
    render();
    expect(within(await cardOf('Lead 1')).getByRole('status')).toHaveTextContent('Do-not-contact flag dismissed by a person.');
  });

  it('4: Approve posts the version that was read; a 409 PLAN_CHANGED shows its message and reads the board again', async () => {
    const calls = stubApi({
      [`GET ${BOARD}`]: board([card(1)], { review: 1 }),
      [`POST /api/call-plans/${ID(1)}/approve`]: respond(409, { error: 'The plan changed since you opened it. Reload and look again.', code: 'PLAN_CHANGED' }),
    });
    render();
    await userEvent.click(within(await cardOf('Lead 1')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The plan changed since you opened it. Reload and look again.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/call-plans/${ID(1)}/approve`, body: { version: 1 } });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === BOARD).length).toBeGreaterThan(1));
  });

  it('5: Edit opens the editor; saving a changed opener sends PUT { version, plan } without doNotContact', async () => {
    const calls = stubApi({ [`GET ${BOARD}`]: board([card(1)], { review: 1 }), [`PUT /api/call-plans/${ID(1)}`]: card(1) });
    render();
    await userEvent.click(within(await cardOf('Lead 1')).getByRole('button', { name: 'Edit' }));
    const opener = screen.getByLabelText('Opener');
    await userEvent.clear(opener);
    await userEvent.type(opener, 'Ask how the house is.');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ version: 1, plan: { opener: 'Ask how the house is.', questions: ['Is everyone on the title on board?'] } });
    expect(put.body as object).not.toHaveProperty('plan.doNotContact');
    expect((put.body as { plan: object }).plan).not.toHaveProperty('doNotContact');
  });

  it('5b: the editor refuses a plan that breaks the contract (no questions) and sends nothing', async () => {
    const calls = stubApi({ [`GET ${BOARD}`]: board([card(1)], { review: 1 }) });
    render();
    await userEvent.click(within(await cardOf('Lead 1')).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText('Questions (one per line)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/questions/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('6: Reject asks first, then posts', async () => {
    const calls = stubApi({ [`GET ${BOARD}`]: board([card(1)], { review: 1 }), [`POST /api/call-plans/${ID(1)}/reject`]: card(1) });
    render();
    await userEvent.click(within(await cardOf('Lead 1')).getByRole('button', { name: 'Reject' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Reject and remove from campaign' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/call-plans/${ID(1)}/reject`)).toBe(true));
  });

  it('6b: Research again posts', async () => {
    const calls = stubApi({ [`GET ${BOARD}`]: board([card(1)], { review: 1 }), [`POST /api/call-plans/${ID(1)}/research`]: card(1) });
    render();
    await userEvent.click(within(await cardOf('Lead 1')).getByRole('button', { name: 'Research again' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/call-plans/${ID(1)}/research`)).toBe(true));
  });

  it('7: a viewer who may not decide gets no action buttons and a note', async () => {
    stubApi({ [`GET ${BOARD}`]: board([card(1, { mayDecide: false })], { review: 1 }) });
    render({ isAdmin: false });
    const c = within(await cardOf('Lead 1'));
    expect(c.getByText('Only the record owner or an admin can decide.')).toBeInTheDocument();
    for (const name of ['Approve', 'Edit', 'Research again', 'Reject']) expect(c.queryByRole('button', { name })).toBeNull();
  });

  it('8: an admin on an active campaign releases the approved calls and sees the result', async () => {
    const calls = stubApi({ [`GET ${BOARD}`]: standard(), [`POST /api/campaigns/${CAMPAIGN_ID}/ai-calls/release`]: { released: 1, skipped: 0 } });
    render();
    await userEvent.click(await screen.findByRole('button', { name: 'Call all approved (1)' }));
    expect(await screen.findByText('1 call queued. 0 skipped.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === `/api/campaigns/${CAMPAIGN_ID}/ai-calls/release`)).toBe(true);
  });

  it('8b: a non-admin never sees the release button', async () => {
    stubApi({ [`GET ${BOARD}`]: standard() });
    render({ isAdmin: false });
    await screen.findByText('1 researching · 1 waiting for review · 1 approved · 0 queued');
    expect(screen.queryByRole('button', { name: /Call all approved/ })).toBeNull();
  });

  it('9: on a dry-run campaign the release button is replaced by a note', async () => {
    stubApi({ [`GET ${BOARD}`]: standard() });
    render({ status: 'dry_run' });
    expect(await screen.findByText('Activate the campaign to place calls.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Call all approved/ })).toBeNull();
  });

  it('a stage filter reads that stage; Load more reads the next page', async () => {
    const calls = stubApi({
      [`GET ${BOARD}`]: board([card(1)], { review: 30 }, 'next-1'),
      [`GET ${BOARD}?cursor=next-1`]: board([card(2)], { review: 30 }),
      [`GET ${BOARD}?stage=approved`]: board([approvedCard(3)], { approved: 1 }),
    });
    render();
    await screen.findByRole('link', { name: 'Lead 1' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Lead 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'approved (0)' }));
    expect(await screen.findByRole('link', { name: 'Lead 3' })).toBeInTheDocument();
    expect(calls.some((c) => c.url === `${BOARD}?stage=approved`)).toBe(true);
  });

  it('a researching lead says so', async () => {
    stubApi({ [`GET ${BOARD}`]: board([researchCard(3)], { research: 1 }) });
    render();
    expect(await screen.findByText('Reading Salesforce and drafting a plan…')).toBeInTheDocument();
  });
});
