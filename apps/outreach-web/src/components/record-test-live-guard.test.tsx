import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, renderWithRouter } from '../test/render';
import { LEAD_ID, OTHER_TEST_ID, TEST_ID, recordTest, recordTestCall } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { RecordTestPage } from './record-test-page';
import { RecordTestPreview } from './record-test-preview';

/** A live browser call must never be dropped by the page itself (plan 1E fix sweep). */
class FakeDevice {
  static isSupported = true;
  on(): void {}
  register(): Promise<void> { return new Promise(() => {}); }
  destroy(): void {}
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const GET = `GET /api/record-tests/${TEST_ID}`;
const LIST = 'GET /api/record-tests';
const AVAILABILITY = 'GET /api/ai-calls/availability';
const INPUT = 'Salesforce Lead or Opportunity Id, or its link';
const recent = {
  items: [{ id: OTHER_TEST_ID, sfObject: 'Opportunity', sfRecordId: '0065e00000XyZ12AAF', name: 'Bob Owner', status: 'ready', createdAt: '2026-10-06T16:00:00.000Z', requestedByName: 'Evren' }],
};

beforeEach(() => {
  // The microphone prompt never answers: the browser run stays in its first active phase.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise(() => {}) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('a live call and the page around it', () => {
  it('a failed poll while a call is live keeps the run controls and shows the error inline', async () => {
    const live = recordTestCall({ callStatus: 'in_progress', outcome: null, createdAt: new Date().toISOString() });
    const table: Record<string, unknown> = { [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: false }, [GET]: recordTest({ calls: [live] }) };
    stubApi(table);
    renderWithProviders(<RecordTestPreview id={TEST_ID} onOpen={() => {}} />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Ring my phone' })).toBeInTheDocument();
    table[GET] = respond(500, { error: 'outreach-api is restarting', code: 'INTERNAL' });
    expect(await screen.findByText(/Couldn't refresh this test/, {}, { timeout: 4000 })).toHaveTextContent('outreach-api is restarting');
    expect(screen.getByRole('button', { name: 'Ring my phone' })).toBeInTheDocument();
    expect(screen.getByText('Jane Seller')).toBeInTheDocument();
  });

  it('while Talk in browser is active, Regenerate, the recent tests and a new preview are off; hanging up turns them back on', async () => {
    stubApi({ [LIST]: recent, [GET]: recordTest(), [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: true } });
    renderWithRouter(<RecordTestPage id={TEST_ID} onOpen={() => {}} />, { isAdmin: true });
    await userEvent.type(await screen.findByLabelText(INPUT), LEAD_ID);
    const talk = await screen.findByRole('button', { name: 'Talk in browser' });
    await waitFor(() => expect(talk).toBeEnabled());
    await userEvent.click(talk);
    expect(await screen.findByRole('button', { name: 'Hang up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Bob Owner/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview the call' })).toBeDisabled();
    expect(screen.getAllByText('Hang up the browser call first: leaving this test would drop it.').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Bob Owner/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Preview the call' })).toBeEnabled();
  });

  it('leaving while the browser call is up asks first: Cancel stays (the call too), OK leaves; a reload or closing the tab asks too', async () => {
    stubApi({ [LIST]: recent, [GET]: recordTest(), [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: true } });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { router } = renderWithRouter(<RecordTestPage id={TEST_ID} onOpen={() => {}} />, { isAdmin: true });
    const talk = await screen.findByRole('button', { name: 'Talk in browser' });
    await waitFor(() => expect(talk).toBeEnabled());
    await userEvent.click(talk);
    expect(await screen.findByRole('button', { name: 'Hang up' })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    // A blocked navigation never settles: don't wait on it.
    void router.navigate({ to: '/settings' as never });
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('A test call is live — leave and hang up?'));
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('button', { name: 'Hang up' })).toBeInTheDocument();
    confirm.mockReturnValue(true);
    await router.navigate({ to: '/settings' as never });
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
  });

  it('with no call up, leaving asks nothing', async () => {
    stubApi({ [LIST]: recent, [GET]: recordTest(), [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: true } });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const { router } = renderWithRouter(<RecordTestPage id={TEST_ID} onOpen={() => {}} />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Talk in browser' })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await router.navigate({ to: '/settings' as never });
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    expect(confirm).not.toHaveBeenCalled();
  });
});
