import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { LEAD_ID, OTHER_TEST_ID, PLAN_TEXT, TEST_ID, recordPlan, recordTest } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { RecordTestPreview } from './record-test-preview';

afterEach(() => vi.unstubAllGlobals());

const GET = `GET /api/record-tests/${TEST_ID}`;
const CREATE = 'POST /api/record-tests';
const AVAILABILITY = 'GET /api/ai-calls/availability';
const RED_CONSENT = 'A campaign would not call this person. A test only rings you.';

function show(routes: Record<string, unknown>, onOpen: (id: string) => void = () => {}) {
  // The stub reads this object on every request, so a test can change an answer between polls.
  const table: Record<string, unknown> = { [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: false }, ...routes };
  const calls = stubApi(table);
  renderWithProviders(<RecordTestPreview id={TEST_ID} onOpen={onOpen} />, { isAdmin: true });
  return { calls, table };
}

describe('RecordTestPreview', () => {
  it('shows progress while running, then every section of the plan once ready', async () => {
    const { table } = show({ [GET]: recordTest({ status: 'running', plan: null, planText: null, slots: [], sources: [], costMicros: 0 }) });
    expect(await screen.findByText('Reading Salesforce and writing the plan… (about a minute)')).toBeInTheDocument();
    table[GET] = recordTest();
    expect(await screen.findByText('AI consent: yes', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Reading Salesforce/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jane Seller' })).toHaveAttribute('href', `https://gg.my.salesforce.com/${LEAD_ID}`);
    expect(screen.queryByText(RED_CONSENT)).not.toBeInTheDocument();
    expect(screen.getByText('Last time we spoke: back in February — the roof')).toBeInTheDocument();
    expect(screen.getByText('The agent will treat them as someone we know.')).toBeInTheDocument();
    expect(screen.getByText('their price in mind, what they owe')).toBeInTheDocument();
    expect(screen.getByText('Ask how the move to Ohio is going.')).toBeInTheDocument();
    expect(screen.getByText('Inherited the house from her mother.')).toBeInTheDocument();
    expect(screen.getByText(/relocating to Ohio in spring/)).toHaveTextContent('(Note, strong)');
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByText(/Confirm the spring date/)).toBeInTheDocument();
    const pre = screen.getByLabelText('The plan text the agent gets');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(PLAN_TEXT);
    expect(screen.getByText(/Phone call Wed Oct 7, 11:00 AM PT/)).toBeInTheDocument();
    expect(screen.getByText(/with Grant/)).toBeInTheDocument();
    expect(screen.getByText('Tasks: 4')).toBeInTheDocument();
    expect(screen.getByText('This preview cost about $0.05.')).toBeInTheDocument();
  });

  it('no earlier contact: the agent will introduce us', async () => {
    show({ [GET]: recordTest({ returning: false, plan: recordPlan({ reengagement: null, stillToLearn: [] }) }) });
    expect(await screen.findByText('No earlier conversation found: the agent will introduce us.')).toBeInTheDocument();
  });

  it('Regenerate POSTs the same Id and opens the new test', async () => {
    const onOpen = vi.fn();
    const { calls } = show({ [GET]: recordTest(), [CREATE]: respond(202, { id: OTHER_TEST_ID }) }, onOpen);
    await userEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(OTHER_TEST_ID));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ record: LEAD_ID });
  });

  it('plan text the agent cannot be given: the red refusal with its words, and no run controls', async () => {
    show({ [GET]: recordTest({ planText: null, planTextWords: ['the opener: a price or an amount'] }) });
    const alert = await screen.findByText(/The voice agent can't be given this plan/);
    expect(alert).toHaveTextContent("The voice agent can't be given this plan: the opener: a price or an amount. Regenerate it.");
    expect(alert).toHaveClass('text-destructive');
    expect(screen.queryByLabelText('The plan text the agent gets')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ring my phone/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Talk in browser/ })).not.toBeInTheDocument();
  });

  it('consent no and a do-not-contact flag both show in red, and never block the preview', async () => {
    show({ [GET]: recordTest({ consent: 'no', plan: recordPlan({ doNotContact: { category: 'attorney', quote: 'talk to my lawyer' } }) }) });
    expect(await screen.findByText('AI consent: no')).toBeInTheDocument();
    expect(screen.getByText(RED_CONSENT)).toHaveClass('text-destructive');
    const dnc = screen.getByText(/Do-not-contact flag: Has an attorney/);
    expect(dnc).toHaveTextContent('“talk to my lawyer”. A campaign would hold this lead in Needs Review.');
    expect(dnc).toHaveClass('text-destructive');
    expect(screen.getByLabelText('The plan text the agent gets')).toBeInTheDocument();
  });

  it('no times offered: the note in words', async () => {
    show({ [GET]: recordTest({ slots: [], offerNote: 'booking_off' }) });
    expect(await screen.findByText('Booking is off, so no times would be offered.')).toBeInTheDocument();
  });

  it('a failed preview says why and offers Try again', async () => {
    const onOpen = vi.fn();
    const { calls } = show({ [GET]: recordTest({ status: 'failed', error: 'not_found', plan: null, planText: null }), [CREATE]: respond(202, { id: OTHER_TEST_ID }) }, onOpen);
    const card = await screen.findByRole('alert');
    expect(card).toHaveTextContent("That record isn't in your Salesforce.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(OTHER_TEST_ID));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ record: LEAD_ID });
    expect(within(document.body).queryByLabelText('The plan text the agent gets')).not.toBeInTheDocument();
  });
});
