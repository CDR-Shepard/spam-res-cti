import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { CALL_A, CALL_B, CALLED_AT, inboundCall, inboundResponse } from '../test/testing-fixtures';
import { formatDateTime } from '../lib/outreach-words';
import { INBOUND_POLL_MS, InboundCallsCard } from './inbound-calls-card';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LIST = 'GET /api/testing/inbound-calls';
const TRANSCRIPT_A = `GET /api/ai-calls/${CALL_A}/transcript`;

async function render(routes: Record<string, unknown> = {}) {
  if (!(LIST in routes)) routes[LIST] = inboundResponse();
  const calls = stubApi(routes);
  const view = renderWithRouter(<InboundCallsCard />, { isAdmin: true });
  return { calls, routes, ...view };
}

describe('InboundCallsCard: how to call in', () => {
  it('names the agent number to dial, formatted', async () => {
    await render();
    expect(await screen.findByRole('heading', { name: 'Inbound calls' })).toBeInTheDocument();
    expect(await screen.findByText('Call (619) 555-0900 from a phone on the list and the agent answers with the inbound prompt.')).toBeInTheDocument();
  });

  it('names every number when the agent has several', async () => {
    await render({ [LIST]: inboundResponse({ aiNumbers: ['+16195550900', '+16195550901'] }) });
    expect(await screen.findByText('Call (619) 555-0900 or (619) 555-0901 from a phone on the list and the agent answers with the inbound prompt.')).toBeInTheDocument();
  });

  it('says so when no agent number takes calls yet', async () => {
    await render({ [LIST]: inboundResponse({ aiNumbers: [] }) });
    expect(await screen.findByText('No agent number takes calls yet.')).toBeInTheDocument();
    expect(screen.queryByText(/from a phone on the list/)).not.toBeInTheDocument();
  });

  it('links to the inbound prompt, opening on its tab', async () => {
    await render();
    const link = await screen.findByRole('link', { name: 'Edit the inbound prompt' });
    expect(link).toHaveAttribute('href', '/settings/agent-prompt?tab=inbound');
  });
});

describe('InboundCallsCard: recent calls', () => {
  it('says so when there are none', async () => {
    await render();
    expect(await screen.findByText('No inbound test calls yet.')).toBeInTheDocument();
  });

  it('shows when, who (the list label, else the number), how long, and a status badge', async () => {
    await render({
      [LIST]: inboundResponse({
        calls: [
          inboundCall({ id: CALL_A, callerLabel: 'Grant cell', outcome: 'qualified', durationSeconds: 95 }),
          inboundCall({ id: CALL_B, callerE164: '+16195550177', callerLabel: null, outcome: 'callback', durationSeconds: 7, startedAt: '2026-10-16T19:00:00.000Z' }),
        ],
      }),
    });
    const grant = await screen.findByRole('listitem', { name: /Grant cell/ });
    expect(within(grant).getByText(formatDateTime(CALLED_AT))).toBeInTheDocument();
    expect(within(grant).getByText('1:35')).toBeInTheDocument();
    expect(within(grant).getByText('Qualified')).toBeInTheDocument();
    const other = screen.getByRole('listitem', { name: /\(619\) 555-0177/ });
    expect(within(other).getByText('0:07')).toBeInTheDocument();
    expect(within(other).getByText('Callback')).toBeInTheDocument();
  });

  it('a call still going reads In progress, with no length yet', async () => {
    await render({ [LIST]: inboundResponse({ calls: [inboundCall({ status: 'in_progress', outcome: null, durationSeconds: null })] }) });
    const row = await screen.findByRole('listitem', { name: /Grant cell/ });
    expect(within(row).getByText('In progress')).toBeInTheDocument();
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('shows the saved details as label and value, and hides the empty ones', async () => {
    await render({
      [LIST]: inboundResponse({
        calls: [inboundCall({ details: { status: 'callback', location: '12 Oak St, Escondido', timeline: '', price_expectation: '$450k', notes: 'Wants a quick close', urgency: '  ' } })],
      }),
    });
    const row = await screen.findByRole('listitem', { name: /Grant cell/ });
    expect(within(row).getByText('Location')).toBeInTheDocument();
    expect(within(row).getByText('12 Oak St, Escondido')).toBeInTheDocument();
    expect(within(row).getByText('Price expectation')).toBeInTheDocument();
    expect(within(row).getByText('$450k')).toBeInTheDocument();
    expect(within(row).getByText('Notes')).toBeInTheDocument();
    expect(within(row).queryByText('Timeline')).not.toBeInTheDocument();
    expect(within(row).queryByText('Urgency')).not.toBeInTheDocument();
    expect(within(row).queryByText('Condition')).not.toBeInTheDocument();
  });

  it('opens and closes the transcript, fetched when it is opened', async () => {
    const user = userEvent.setup();
    const { calls } = await render({
      [LIST]: inboundResponse({ calls: [inboundCall()] }),
      [TRANSCRIPT_A]: { aiCallId: CALL_A, lines: [{ role: 'agent', text: 'Thanks for calling GG Homes.', at: null }, { role: 'caller', text: 'I want to sell my house.', at: null }], turnStats: null },
    });
    await user.click(await screen.findByRole('button', { name: 'Transcript' }));
    expect(await screen.findByText('Thanks for calling GG Homes.')).toBeInTheDocument();
    expect(screen.getByText('I want to sell my house.')).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/api/ai-calls/${CALL_A}/transcript`)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.queryByText('Thanks for calling GG Homes.')).not.toBeInTheDocument();
  });

  it('a transcript that cannot be read shows its error', async () => {
    const user = userEvent.setup();
    await render({ [LIST]: inboundResponse({ calls: [inboundCall()] }), [TRANSCRIPT_A]: respond(403, { error: 'Admin access required', code: 'ADMIN_ONLY' }) });
    await user.click(await screen.findByRole('button', { name: 'Transcript' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admins can do that.');
  });

  it('shows the error when the calls cannot be read', async () => {
    await render({ [LIST]: respond(500, { error: 'Something went wrong on our side. Try again in a minute.', code: 'INTERNAL_ERROR' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side. Try again in a minute.');
  });
});

describe('InboundCallsCard: refreshing', () => {
  it('reads again every 10 seconds while the page is open, and shows a new call when it arrives', async () => {
    expect(INBOUND_POLL_MS).toBe(10_000);
    // Only the interval is faked: the query's refresh timer is set when the page mounts, so the fake goes in first.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { calls, routes } = await render();
    await screen.findByText('No inbound test calls yet.');
    expect(calls.filter((c) => c.url === '/api/testing/inbound-calls')).toHaveLength(1);
    routes[LIST] = inboundResponse({ calls: [inboundCall({ callerLabel: 'Sam' })] });
    await vi.advanceTimersByTimeAsync(INBOUND_POLL_MS - 100);
    expect(calls.filter((c) => c.url === '/api/testing/inbound-calls')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await screen.findByRole('listitem', { name: /Sam/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/testing/inbound-calls')).toHaveLength(2);
  });
});
