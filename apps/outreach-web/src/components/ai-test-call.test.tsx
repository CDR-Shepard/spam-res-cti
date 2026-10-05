import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { AiTestCall } from './ai-test-call';

afterEach(() => vi.unstubAllGlobals());

const AVAILABILITY = 'GET /api/ai-calls/availability';
const TEST = 'POST /api/ai-calls/test';
const CALL = '99999999-9999-4999-8999-999999999999';
const available = { available: true, testNumbers: ['+15125550111', '+15125550122'] };

describe('AiTestCall', () => {
  it('is not rendered for a non-admin, and asks nothing', async () => {
    const calls = stubApi({ [AVAILABILITY]: available });
    const { container } = renderWithProviders(<AiTestCall />, { isAdmin: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('is not rendered when AI calls are not available', async () => {
    const calls = stubApi({ [AVAILABILITY]: { available: false, testNumbers: [] } });
    const { container } = renderWithProviders(<AiTestCall />, { isAdmin: true });
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('an admin picks a test number and starts the call; placed reads "Calling now"', async () => {
    const calls = stubApi({ [AVAILABILITY]: available, [TEST]: { result: 'placed', aiCallId: CALL } });
    renderWithProviders(<AiTestCall />, { isAdmin: true });
    expect(await screen.findByText('Test call to my phone', { selector: '[data-slot="card-title"]' })).toBeInTheDocument();
    expect(screen.getByText(/Use it each morning before a campaign calls anyone \(runbook: AI voice §5\)/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Test number'), '+15125550122');
    await userEvent.click(screen.getByRole('button', { name: 'Test call to my phone' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Calling now. Pick up to hear the agent.');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ to: '+15125550122' });
  });

  it('a refusal shows its words', async () => {
    stubApi({ [AVAILABILITY]: available, [TEST]: { result: 'blocked', reason: 'not_admin_for_test', aiCallId: CALL } });
    renderWithProviders(<AiTestCall />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Test call to my phone' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Not called: test calls are for admins, to a number in AI_VOICE_TEST_NUMBERS');
  });

  it('a 502 shows the error text', async () => {
    stubApi({ [AVAILABILITY]: available, [TEST]: respond(502, { error: 'The AI calling service did not answer. Try again in a minute.', code: 'CTI_UNREACHABLE' }) });
    renderWithProviders(<AiTestCall />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Test call to my phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI calling service did not answer. Try again in a minute.');
  });

  it('with no test numbers it says how to add one, and offers no button', async () => {
    stubApi({ [AVAILABILITY]: { available: true, testNumbers: [] } });
    renderWithProviders(<AiTestCall />, { isAdmin: true });
    expect(await screen.findByText('No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Test call to my phone' })).not.toBeInTheDocument();
  });

  it('when the AI calling service cannot be reached, says so without raising an alert', async () => {
    stubApi({ [AVAILABILITY]: respond(503, { error: 'The AI calling service did not answer. Try again in a minute.', code: 'CTI_UNREACHABLE' }) });
    renderWithProviders(<AiTestCall />, { isAdmin: true });
    expect(await screen.findByText('The AI calling service did not answer. Try again in a minute.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
