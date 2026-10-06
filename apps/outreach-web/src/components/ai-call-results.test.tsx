import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiCallResult, AiCallResultsResponse, BookedAppointment, WritebackSummary } from '@cti/contracts';
import { appointmentWords } from '@/lib/call-words';
import { formatDateTime } from '@/lib/outreach-words';
import { renderWithProviders } from '../test/render';
import { CAMPAIGN_ID } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { AiCallResults, RESULTS_POLL_MS, resultsPollInterval } from './ai-call-results';

afterEach(() => vi.unstubAllGlobals());

const RESULTS = `/api/campaigns/${CAMPAIGN_ID}/ai-calls`;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CALL = '99999999-9999-4999-8999-999999999999';

function row(n: number, over: Partial<AiCallResult> = {}): AiCallResult {
  return {
    touchId: ID(n),
    enrollmentId: ID(n + 5),
    name: `Lead ${n}`,
    sfObject: 'Lead',
    sfRecordId: `00Q00000000000${n}AAA`,
    recordUrl: `https://gghomes.my.salesforce.com/00Q00000000000${n}AAA`,
    touchStatus: 'sent',
    dueAt: '2026-10-05T22:00:00.000Z',
    attempts: 1,
    lastBlockReason: null,
    aiCallId: null,
    callStatus: null,
    outcome: null,
    summary: null,
    qualification: null,
    durationSeconds: null,
    startedAt: null,
    enrollmentStatus: 'active',
    exitReason: null,
    mayReadTranscript: false,
    appointment: null,
    writeback: null,
    ...over,
  };
}
const page = (items: AiCallResult[], nextCursor: string | null = null): AiCallResultsResponse => ({ items, nextCursor });
const rowOf = async (name: string) => (await screen.findByRole('link', { name })).closest('tr') as HTMLElement;

describe('AiCallResults', () => {
  it('1: a placed call shows the linked name, the status, the outcome, the summary and the qualification', async () => {
    stubApi({
      [`GET ${RESULTS}`]: page([
        row(1, {
          aiCallId: CALL,
          callStatus: 'completed',
          outcome: 'qualified_callback',
          summary: 'Wants a call back Thursday evening.',
          qualification: { timeline: '3 months', condition: 'needs a roof' },
          startedAt: '2026-10-05T23:00:00.000Z',
        }),
      ]),
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const link = await screen.findByRole('link', { name: 'Lead 1' });
    expect(link).toHaveAttribute('href', 'https://gghomes.my.salesforce.com/00Q000000000001AAA');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    const r = within(await rowOf('Lead 1'));
    expect(r.getByText('Completed')).toBeInTheDocument();
    expect(r.getByText('Callback booked')).toBeInTheDocument();
    expect(r.getByText('Wants a call back Thursday evening.')).toBeInTheDocument();
    expect(r.getByText('timeline:')).toBeInTheDocument();
    expect(r.getByText('3 months')).toBeInTheDocument();
    expect(r.getByText('condition:')).toBeInTheDocument();
    expect(r.getByText('needs a roof')).toBeInTheDocument();
    expect(r.getByText(formatDateTime('2026-10-05T23:00:00.000Z'))).toBeInTheDocument();
  });

  it('2: a refused call says why it was not called', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([row(2, { touchStatus: 'failed', lastBlockReason: 'no_consent', enrollmentStatus: 'exited', exitReason: 'ai_call_no_consent' })]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    expect(within(await rowOf('Lead 2')).getByText('Not called: no AI consent in Salesforce')).toBeInTheDocument();
  });

  it('3: a waiting call shows its next try and the attempt it will be', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([row(3, { touchStatus: 'planned', attempts: 1, lastBlockReason: 'calling_hours', dueAt: '2026-10-06T13:00:00.000Z' })]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const r = within(await rowOf('Lead 3'));
    expect(r.getByText(`Waiting — next try ${formatDateTime('2026-10-06T13:00:00.000Z')}`)).toBeInTheDocument();
    expect(r.getByText(/attempt 2/)).toBeInTheDocument();
  });

  it('a completed lead says how it ended; a lead with no link shows its name', async () => {
    stubApi({
      [`GET ${RESULTS}`]: page([
        row(4, { aiCallId: CALL, callStatus: 'completed', outcome: 'voicemail', enrollmentStatus: 'completed', exitReason: 'ai_call_no_answer' }),
        row(5, { recordUrl: null, touchStatus: 'skipped', exitReason: 'deselected', enrollmentStatus: 'exited' }),
      ]),
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const r = within(await rowOf('Lead 4'));
    expect(r.getByText('Voicemail')).toBeInTheDocument();
    expect(r.getByText('No answer after every attempt')).toBeInTheDocument();
    expect(screen.getByText('Lead 5')).toBeInTheDocument();
    expect(screen.getByText('Removed from the lead picker')).toBeInTheDocument();
  });

  it('4: the transcript opens only where it may be read, and labels who spoke', async () => {
    const calls = stubApi({
      [`GET ${RESULTS}`]: page([row(1, { aiCallId: CALL, callStatus: 'completed', mayReadTranscript: true }), row(2, { aiCallId: ID(9), callStatus: 'completed', mayReadTranscript: false })]),
      [`GET /api/ai-calls/${CALL}/transcript`]: {
        aiCallId: CALL,
        lines: [
          { role: 'agent', text: 'Hi, this is an AI assistant on a recorded line.', at: null },
          { role: 'caller', text: 'Oh, hello.', at: null },
        ],
      },
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const first = within(await rowOf('Lead 1'));
    expect(within(await rowOf('Lead 2')).queryByRole('button', { name: 'Transcript' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/transcript'))).toBe(false);
    await userEvent.click(first.getByRole('button', { name: 'Transcript' }));
    expect(await screen.findByText('Hi, this is an AI assistant on a recorded line.')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Them')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/api/ai-calls/${CALL}/transcript`)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.queryByText('Oh, hello.')).not.toBeInTheDocument();
  });

  it('pages with Load more', async () => {
    const calls = stubApi({
      [`GET ${RESULTS}`]: page([row(1)], 'next1'),
      [`GET ${RESULTS}?cursor=next1`]: page([row(2)]),
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Lead 2' })).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain(`${RESULTS}?cursor=next1`);
  });

  it('says so when no call was queued yet', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    expect(await screen.findByText(/No AI calls yet/)).toBeInTheDocument();
  });
});

describe('plan 1D: appointment and Salesforce columns', () => {
  const BOOKED: BookedAppointment = {
    slotId: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
    specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: false, note: '', bookedAt: '2026-10-06T22:05:00.000Z',
  };
  const WB: WritebackSummary = {
    status: 'done', error: null, mayRetry: false, convertedOpportunityId: null, convertedOpportunityUrl: null,
    changes: [{ kind: 'changed', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set' }],
  };
  const booked = (over: Partial<AiCallResult> = {}) =>
    row(1, { aiCallId: CALL, callStatus: 'completed', outcome: 'appointment_set', appointment: BOOKED, writeback: WB, ...over });

  it('a booked call shows the appointment in the viewer\'s zone and a Done badge that opens what was written', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([booked()]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const r = within(await rowOf('Lead 1'));
    expect(r.getByText(appointmentWords(BOOKED))).toBeInTheDocument();
    expect(screen.queryByText('Stage: New Opportunity → Appointment Set')).not.toBeInTheDocument();
    const status = r.getByRole('button', { name: 'Salesforce write-back: Done, show what was written' });
    expect(status).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(status);
    expect(await screen.findByText('Stage: New Opportunity → Appointment Set')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Salesforce write-back: Done, hide what was written' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('final review m6: the Transcript toggle says whether it is open', async () => {
    stubApi({
      [`GET ${RESULTS}`]: page([booked({ mayReadTranscript: true })]),
      [`GET /api/ai-calls/${CALL}/transcript`]: { aiCallId: CALL, lines: [] },
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const button = within(await rowOf('Lead 1')).getByRole('button', { name: 'Transcript' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(within(await rowOf('Lead 1')).getByRole('button', { name: 'Hide transcript' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('Retry on a failed write-back POSTs and reads the results again', async () => {
    const calls = stubApi({
      [`GET ${RESULTS}`]: page([booked({ writeback: { ...WB, status: 'failed', mayRetry: true, error: 'SERVER_UNAVAILABLE' } })]),
      [`POST /api/ai-calls/${CALL}/writeback/retry`]: respond(204),
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />, { isAdmin: true });
    await userEvent.click(within(await rowOf('Lead 1')).getByRole('button', { name: 'Salesforce write-back: Failed, show what was written' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(calls.filter((c) => c.url === RESULTS)).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a converted Lead shows "Converted to Opportunity", linking to the new record', async () => {
    // P6 M-3: the link is the server's, never rebuilt from the Lead's URL.
    const url = 'https://gghomes.lightning.force.com/lightning/r/Opportunity/006000000000009AAA/view';
    stubApi({ [`GET ${RESULTS}`]: page([booked({ writeback: { ...WB, convertedOpportunityId: '006000000000009AAA', convertedOpportunityUrl: url } })]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const link = await screen.findByRole('link', { name: 'Converted to Opportunity' });
    expect(link).toHaveAttribute('href', url);
  });

  it('no write-back and no booking leave both cells empty', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([row(1, { aiCallId: CALL, callStatus: 'completed', outcome: 'not_interested' })]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} />);
    const r = within(await rowOf('Lead 1'));
    expect(r.queryByRole('button', { name: /Salesforce write-back/ })).not.toBeInTheDocument();
    expect(r.queryByText(/Phone call|Walkthrough/)).not.toBeInTheDocument();
  });

  it('the ?call= deep link (the Chatter post\'s "Call details") marks that call and opens its transcript and write-back', async () => {
    stubApi({
      [`GET ${RESULTS}`]: page([row(2), booked({ mayReadTranscript: true })], 'next1'),
      [`GET /api/ai-calls/${CALL}/transcript`]: { aiCallId: CALL, lines: [{ role: 'agent', text: 'Hello from the deep link.', at: null }] },
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} focusCallId={CALL} />);
    expect(await screen.findByText('Hello from the deep link.')).toBeInTheDocument();
    expect(screen.getByText('Stage: New Opportunity → Appointment Set')).toBeInTheDocument();
    expect(await rowOf('Lead 1')).toHaveAttribute('aria-current', 'true');
    expect(await rowOf('Lead 2')).not.toHaveAttribute('aria-current');
  });

  it('a deep-linked call on a later page is read until it is found', async () => {
    const calls = stubApi({
      [`GET ${RESULTS}`]: page([row(2)], 'next1'),
      [`GET ${RESULTS}?cursor=next1`]: page([booked()]),
    });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} focusCallId={CALL} />);
    expect(await rowOf('Lead 1')).toHaveAttribute('aria-current', 'true');
    expect(calls.map((c) => c.url)).toContain(`${RESULTS}?cursor=next1`);
  });

  it('P6 M-4: a deep-linked call on none of the pages says so', async () => {
    stubApi({ [`GET ${RESULTS}`]: page([row(2)]) });
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} focusCallId={CALL} />);
    expect(await screen.findByText("That call isn't in the latest results.")).toBeInTheDocument();
    expect(await rowOf('Lead 2')).not.toHaveAttribute('aria-current');
  });

  it('P6 M-4: a deep-linked call not found within the page cap says so, and no more pages are read', async () => {
    const routes: Record<string, AiCallResultsResponse> = { [`GET ${RESULTS}`]: page([row(100)], 'p1') };
    for (let n = 1; n <= 12; n += 1) routes[`GET ${RESULTS}?cursor=p${n}`] = page([row(100 + n)], `p${n + 1}`);
    const calls = stubApi(routes);
    renderWithProviders(<AiCallResults campaignId={CAMPAIGN_ID} focusCallId={CALL} />);
    expect(await screen.findByText("That call isn't in the latest results.")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith(RESULTS))).toHaveLength(10);
  });
});

describe('5: polling', () => {
  it.each([
    ['a planned touch', [row(1, { touchStatus: 'planned' })], RESULTS_POLL_MS],
    ['a dialing touch', [row(1, { touchStatus: 'dialing' })], RESULTS_POLL_MS],
    ['a ringing call', [row(1, { callStatus: 'ringing' })], RESULTS_POLL_MS],
    ['a call in progress', [row(1, { callStatus: 'in_progress' })], RESULTS_POLL_MS],
    ['a queued call', [row(1, { callStatus: 'queued' })], RESULTS_POLL_MS],
    ['a transferring call', [row(1, { callStatus: 'transferring' })], RESULTS_POLL_MS],
    ['only finished calls', [row(1, { callStatus: 'completed' }), row(2, { touchStatus: 'failed' })], false],
    ['nothing', [], false],
  ] as const)('%s → %s', (_label, items, want) => {
    expect(RESULTS_POLL_MS).toBe(15_000);
    expect(resultsPollInterval([page([...items])])).toBe(want);
  });

  it('final review m12: after a deep link read more than one page, only the linked call keeps the poll going', () => {
    const live = row(1, { callStatus: 'ringing' });
    const linked = (callStatus: AiCallResult['callStatus']) => row(2, { aiCallId: CALL, callStatus });
    expect(resultsPollInterval([page([live], 'p1'), page([linked('completed')])], CALL)).toBe(false);
    expect(resultsPollInterval([page([live], 'p1'), page([linked('in_progress')])], CALL)).toBe(RESULTS_POLL_MS);
    // One page (the usual view, linked or not) polls as before.
    expect(resultsPollInterval([page([live, linked('completed')])], CALL)).toBe(RESULTS_POLL_MS);
    // Still paging toward the linked call: no poll on top of the paging.
    expect(resultsPollInterval([page([live], 'p1'), page([row(3)], 'p2')], CALL)).toBe(false);
  });
});
