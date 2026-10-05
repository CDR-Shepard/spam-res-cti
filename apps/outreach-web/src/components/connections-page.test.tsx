import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { connection, fieldMap } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { ConnectionsPage } from './connections-page';

const AUTHORIZE_URL = 'https://login.salesforce.com/services/oauth2/authorize?state=s1';
const realLocation = window.location;

/** jsdom's `location.assign` can't be spied on directly (see -routes.test.tsx); swap the whole object. */
function stubAssign() {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
  return assign;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

const notConnected = connection({ connected: false, status: null, instanceUrl: null, username: null, connectedAt: null, fieldMap: null });

describe('ConnectionsPage status card', () => {
  it('explains a server without Salesforce settings and offers no Connect button', async () => {
    stubApi({ 'GET /api/connections/salesforce': { ...notConnected, configured: false } });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    expect(await screen.findByText(/Salesforce is not set up on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Salesforce' })).not.toBeInTheDocument();
  });

  it('lets an admin start the Salesforce sign-in and sends the browser to it', async () => {
    const assign = stubAssign();
    const calls = stubApi({
      'GET /api/connections/salesforce': notConnected,
      'POST /api/connections/salesforce/start': { url: AUTHORIZE_URL },
    });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Salesforce' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/connections/salesforce/start']);
  });

  it('tells a member to ask an admin instead of showing the button', async () => {
    stubApi({ 'GET /api/connections/salesforce': notConnected });
    renderWithProviders(<ConnectionsPage />);
    expect(await screen.findByText('Ask an admin to connect Salesforce.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Salesforce' })).not.toBeInTheDocument();
  });

  it('shows the connected org, user, and an admin Reconnect', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection() });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    expect(await screen.findByText('https://gghomes.my.salesforce.com')).toBeInTheDocument();
    expect(screen.getByText('integration@gghomes.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('shows a broken connection with its last error and reconnects through startConnection', async () => {
    const assign = stubAssign();
    stubApi({
      'GET /api/connections/salesforce': connection({ status: 'broken', lastError: 'expired access/refresh token' }),
      'POST /api/connections/salesforce/start': { url: AUTHORIZE_URL },
    });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    expect(await screen.findByText(/stopped working: expired access\/refresh token/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL));
  });

  it('disconnects only after the admin confirms', async () => {
    const calls = stubApi({ 'GET /api/connections/salesforce': connection(), 'DELETE /api/connections/salesforce': respond(204) });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/pause until Salesforce is connected again/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/connections/salesforce')).toBe(true));
  });
});

describe('ConnectionsPage callback messages', () => {
  it('confirms a successful connection', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection() });
    renderWithProviders(<ConnectionsPage connected />);
    expect(screen.getByRole('status')).toHaveTextContent('Salesforce is connected.');
  });
  it.each([
    ['access_denied', 'Salesforce sign-in was cancelled.'],
    ['bad_state', 'That connection attempt expired or was started in another tab. Try again.'],
    ['describe_failed', "We signed in but couldn't read Lead and Opportunity fields. Check the integration user's permissions, then try again."],
    ['something_new', 'Connecting Salesforce failed. Try again.'],
    ['constructor', 'Connecting Salesforce failed. Try again.'],
  ])('words ?error=%s', (code, words) => {
    stubApi({ 'GET /api/connections/salesforce': notConnected });
    renderWithProviders(<ConnectionsPage error={code} />);
    expect(screen.getByRole('alert')).toHaveTextContent(words);
  });
});

describe('ConnectionsPage field map', () => {
  it('lets an admin remove and add notes fields, reorder phones, and save the whole map', async () => {
    const calls = stubApi({ 'GET /api/connections/salesforce': connection(), 'PUT /api/connections/salesforce/field-map': respond(204) });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    const lead = await screen.findByRole('region', { name: 'Lead fields' });
    await userEvent.click(within(lead).getByRole('button', { name: 'Remove Description' }));
    await userEvent.type(within(lead).getByLabelText('Add a notes field'), 'Motivation__c');
    await userEvent.click(within(lead).getByRole('button', { name: 'Add' }));
    await userEvent.click(within(lead).getByRole('button', { name: 'Move Phone up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save fields' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const expected = fieldMap();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      ...expected,
      Lead: { ...expected.Lead, notes: ['Notes__c', 'Motivation__c'], phones: ['Phone', 'MobilePhone'] },
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('refuses a duplicate or malformed field name', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection() });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    const lead = await screen.findByRole('region', { name: 'Lead fields' });
    await userEvent.type(within(lead).getByLabelText('Add a notes field'), 'notes__c');
    await userEvent.click(within(lead).getByRole('button', { name: 'Add' }));
    expect(within(lead).getByRole('alert')).toHaveTextContent('notes__c is already in the list.');
    await userEvent.clear(within(lead).getByLabelText('Add a notes field'));
    await userEvent.type(within(lead).getByLabelText('Add a notes field'), 'Notes c');
    await userEvent.click(within(lead).getByRole('button', { name: 'Add' }));
    expect(within(lead).getByRole('alert')).toHaveTextContent('Use the field API name');
  });

  it('shows members the fields read-only', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection() });
    renderWithProviders(<ConnectionsPage />);
    const lead = await screen.findByRole('region', { name: 'Lead fields' });
    expect(within(lead).getByText('Notes__c')).toBeInTheDocument();
    expect(within(lead).queryByRole('button', { name: 'Remove Notes__c' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save fields' })).not.toBeInTheDocument();
  });
});
