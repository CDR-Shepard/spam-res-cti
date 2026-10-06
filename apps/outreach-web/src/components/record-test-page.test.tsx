import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, renderWithRouter } from '../test/render';
import { LEAD_ID, LEAD_URL, OTHER_TEST_ID, TEST_ID } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { AppShell } from './app-shell';
import { RecordTestPage } from './record-test-page';

afterEach(() => vi.unstubAllGlobals());

const LIST = 'GET /api/record-tests';
const CREATE = 'POST /api/record-tests';
const INPUT = 'Salesforce Lead or Opportunity Id, or its link';
const recent = {
  items: [
    { id: OTHER_TEST_ID, sfObject: 'Opportunity', sfRecordId: '0065e00000XyZ12AAF', name: 'Bob Owner', status: 'ready', createdAt: '2026-10-06T16:00:00.000Z', requestedByName: 'Evren' },
    { id: TEST_ID, sfObject: 'Lead', sfRecordId: LEAD_ID, name: null, status: 'failed', createdAt: '2026-10-06T15:00:00.000Z', requestedByName: null },
  ],
};

describe('Test a record: who sees it', () => {
  it('a rep has no nav link and the page only says it is for admins', async () => {
    const calls = stubApi({});
    renderWithRouter(<AppShell><RecordTestPage id={null} onOpen={() => {}} /></AppShell>);
    expect(await screen.findByText('Only admins can test records.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Test a record' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(INPUT)).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('an admin has the nav link', async () => {
    stubApi({ [LIST]: { items: [] } });
    renderWithRouter(<AppShell><p>x</p></AppShell>, { isAdmin: true });
    expect(await screen.findByRole('link', { name: 'Test a record' })).toHaveAttribute('href', '/test-record');
  });
});

describe('Test a record: the form', () => {
  it('an Account Id shows the words and keeps the button off', async () => {
    stubApi({ [LIST]: { items: [] } });
    renderWithProviders(<RecordTestPage id={null} onOpen={() => {}} />, { isAdmin: true });
    const button = screen.getByRole('button', { name: 'Preview the call' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(INPUT), '0015e00000AbCdE');
    expect(screen.getByText('Only Leads (00Q…) and Opportunities (006…) can be tested.')).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('a Lightning Lead link reads as the Lead; Preview POSTs its Id and opens the new test', async () => {
    const onOpen = vi.fn();
    const calls = stubApi({ [LIST]: { items: [] }, [CREATE]: respond(202, { id: TEST_ID }) });
    renderWithProviders(<RecordTestPage id={null} onOpen={onOpen} />, { isAdmin: true });
    await userEvent.type(screen.getByLabelText(INPUT), LEAD_URL);
    expect(screen.getByText(`Lead ${LEAD_ID}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview the call' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(TEST_ID));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ record: LEAD_ID });
  });

  it('a 429 says when to try again, in the viewer\'s own zone', async () => {
    const retryAt = '2026-10-06T22:42:00.000Z';
    stubApi({
      [LIST]: { items: [] },
      [CREATE]: respond(429, { error: "You've run 10 previews in the last hour. Try again at 3:42 PM PT.", code: 'RATE_LIMITED', details: { retryAt } }),
    });
    renderWithProviders(<RecordTestPage id={null} onOpen={() => {}} />, { isAdmin: true });
    await userEvent.type(screen.getByLabelText(INPUT), LEAD_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Preview the call' }));
    const local = new Date(retryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    expect(await screen.findByRole('alert')).toHaveTextContent(`You've run 10 previews in the last hour. Try again at ${local}.`);
  });
});

describe('Test a record: recent tests', () => {
  it("lists the tenant's latest with time, name, object, status and who ran it; a click opens one", async () => {
    const onOpen = vi.fn();
    stubApi({ [LIST]: recent });
    renderWithProviders(<RecordTestPage id={null} onOpen={onOpen} />, { isAdmin: true });
    const bob = await screen.findByRole('button', { name: /Bob Owner/ });
    expect(bob).toHaveTextContent('Opportunity');
    expect(bob).toHaveTextContent('Ready');
    expect(bob).toHaveTextContent('Evren');
    expect(screen.getByRole('button', { name: new RegExp(LEAD_ID) })).toHaveTextContent('Failed');
    await userEvent.click(bob);
    expect(onOpen).toHaveBeenCalledWith(OTHER_TEST_ID);
  });
});
