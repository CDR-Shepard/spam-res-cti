import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { AI_CALL_ID, CALL_ID, TEST_ID, recordTest, recordTestCall } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { RecordTestRun } from './record-test-run';
import { RecordTestPreview, recordTestPollInterval } from './record-test-preview';

class FakeDevice {
  static isSupported = true;
  on(): void {}
  register(): Promise<void> { return new Promise(() => {}); }
  destroy(): void {}
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

afterEach(() => vi.unstubAllGlobals());

const AVAILABILITY = 'GET /api/ai-calls/availability';
const RUN = `POST /api/record-tests/${TEST_ID}/calls`;
const available = (browserCalls: boolean) => ({ available: true, testNumbers: ['+15125550111', '+12125550100'], browserCalls });
const HINT = 'Exactly the call the seller would get, with the real record, plan and times. Nothing is written to Salesforce; a booking is only shown here.';

describe('RecordTestRun', () => {
  it('a ready preview offers both; Ring my phone POSTs the picked number', async () => {
    const calls = stubApi({ [AVAILABILITY]: available(true), [RUN]: { callId: CALL_ID, response: { result: 'placed', aiCallId: AI_CALL_ID } } });
    renderWithProviders(<RecordTestRun test={recordTest()} />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Talk in browser' })).toBeEnabled();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(screen.getByText("Use headphones so the AI doesn't hear itself. You are the seller.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Test number'), '+12125550100');
    await userEvent.click(screen.getByRole('button', { name: 'Ring my phone' }));
    expect(await screen.findByText('Ringing your phone…')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ mode: 'phone', to: '+12125550100' });
  });

  it('no browser calls on the calling service: no Talk in browser', async () => {
    stubApi({ [AVAILABILITY]: available(false) });
    renderWithProviders(<RecordTestRun test={recordTest()} />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Ring my phone' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Talk in browser' })).not.toBeInTheDocument();
  });

  it('a plan the agent cannot be given has no run controls', () => {
    const calls = stubApi({ [AVAILABILITY]: available(true) });
    const { container } = renderWithProviders(<RecordTestRun test={recordTest({ planText: null, planTextWords: ['the opener: a price'] })} />, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('a live call disables both buttons and keeps the page polling', async () => {
    const live = recordTest({ calls: [recordTestCall({ callStatus: 'in_progress', outcome: null, createdAt: new Date().toISOString() })] });
    stubApi({ [AVAILABILITY]: available(true) });
    renderWithProviders(<RecordTestRun test={live} />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Talk in browser' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ring my phone' })).toBeDisabled();
    expect(screen.getByText('Your test call: In progress')).toBeInTheDocument();
    expect(recordTestPollInterval(live)).toBe(2_000);
    expect(recordTestPollInterval(recordTest({ calls: [recordTestCall()] }))).toBe(false);
  });

  it("the server's CALL_IN_PROGRESS shows in words", async () => {
    stubApi({ [AVAILABILITY]: available(false), [RUN]: respond(409, { error: 'Your last test call is still going. Wait for it to end.', code: 'CALL_IN_PROGRESS' }) });
    renderWithProviders(<RecordTestRun test={recordTest()} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Ring my phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your last test call is still going. Wait for it to end.');
  });

  it('Talk in browser on a page with no microphone access (jsdom: not a secure context) says why', async () => {
    stubApi({ [AVAILABILITY]: available(true) });
    renderWithProviders(<RecordTestRun test={recordTest()} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Talk in browser' }));
    expect(await screen.findByText('The microphone only works on a secure (https) page. Open the app over https, or use Ring my phone.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Talk in browser' })).toBeEnabled());
  });

  it('"Ringing your phone…" clears once that call has ended', async () => {
    const GET = `GET /api/record-tests/${TEST_ID}`;
    const at = new Date().toISOString();
    const table: Record<string, unknown> = { [AVAILABILITY]: available(false), [GET]: recordTest(), [RUN]: { callId: CALL_ID, response: { result: 'placed', aiCallId: AI_CALL_ID } } };
    stubApi(table);
    renderWithProviders(<RecordTestPreview id={TEST_ID} onOpen={() => {}} />, { isAdmin: true });
    table[GET] = recordTest({ calls: [recordTestCall({ createdAt: at, callStatus: 'ringing', outcome: null })] });
    await userEvent.click(await screen.findByRole('button', { name: 'Ring my phone' }));
    expect(await screen.findByText('Ringing your phone…')).toBeInTheDocument();
    table[GET] = recordTest({ calls: [recordTestCall({ createdAt: at })] });
    await waitFor(() => expect(screen.queryByText('Ringing your phone…')).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText('Appointment set · 2:05')).toBeInTheDocument();
  });
});
