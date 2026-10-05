import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { AuthProvider } from '../lib/auth';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { SignInPage } from './sign-in-page';

const FALLBACK = 'Sign-in failed. Try again.';
const PROVIDERS = 'GET /api/auth/providers';

afterEach(() => vi.unstubAllGlobals());

/** The real AuthProvider (so `startSignIn` really navigates), with `window.location.assign` captured. */
function renderSignIn(ui: ReactElement) {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AuthProvider>{ui}</AuthProvider></QueryClientProvider>);
  return { assign };
}

describe('SignInPage', () => {
  it('renders no alert when there is no error', () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    renderWithProviders(<SignInPage />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([
    ['bad_state'],
    ['missing_code'],
    ['sign_in_disabled'],
    ['bad_return_to'],
    ['no_tenant'],
    ['no_account'],
    ['org_not_allowed'],
    ['salesforce_unavailable'],
  ])('maps the API reason %s to a specific message (not the generic fallback)', (error) => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    renderWithProviders(<SignInPage error={error} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toBe('');
    expect(alert).not.toHaveTextContent(FALLBACK);
  });
  it.each([
    ['no_account', 'Your Salesforce user is not set up in the CTI yet. Sign in to the CTI softphone once, or ask an admin to add you.'],
    ['org_not_allowed', 'This Salesforce org is not allowed to use Outreach.'],
    ['salesforce_unavailable', 'Salesforce did not answer. Try again in a minute.'],
    ['no_tenant', 'This Salesforce org is not set up for Outreach. Contact your administrator.'],
  ])('words the reason %s as the Salesforce sign-in needs it', (error, message) => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    renderWithProviders(<SignInPage error={error} />);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });
  it('renders the generic fallback for an unknown reason', () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    renderWithProviders(<SignInPage error="something_new" />);
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK);
  });
  it('renders the generic fallback for a prototype property name (a public URL like /sign-in?error=constructor must not resolve to Object.prototype)', () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    renderWithProviders(<SignInPage error="constructor" />);
    expect(screen.getByRole('alert')).toHaveTextContent(FALLBACK);
  });

  it('1: with only Salesforce on, shows one button that starts the Salesforce sign-in with the returnTo, and no WorkOS button', async () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    const { assign } = renderSignIn(<SignInPage returnTo="/campaigns" />);
    expect(screen.getByText('Sign in with your Salesforce account.')).toBeInTheDocument();
    const button = await screen.findByRole('button', { name: 'Sign in with Salesforce' });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await userEvent.click(button);
    expect(assign).toHaveBeenCalledWith('/api/auth/salesforce/start?returnTo=%2Fcampaigns');
    expect(screen.queryByRole('button', { name: 'Sign in with email' })).not.toBeInTheDocument();
  });

  it('1b: without a returnTo the start URL carries no query', async () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: false } });
    const { assign } = renderSignIn(<SignInPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Salesforce' }));
    expect(assign).toHaveBeenCalledWith('/api/auth/salesforce/start');
  });

  it('2: with both on, shows Salesforce as the primary button and email as the secondary one, to the WorkOS start route', async () => {
    stubApi({ [PROVIDERS]: { salesforce: true, workos: true } });
    const { assign } = renderSignIn(<SignInPage returnTo="/campaigns" />);
    const email = await screen.findByRole('button', { name: 'Sign in with email' });
    const salesforce = screen.getByRole('button', { name: 'Sign in with Salesforce' });
    expect(salesforce.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(email);
    expect(assign).toHaveBeenCalledWith('/api/auth/workos/start?returnTo=%2Fcampaigns');
  });

  it('3: with neither on, shows no button and the sign_in_disabled message', async () => {
    stubApi({ [PROVIDERS]: { salesforce: false, workos: false } });
    renderSignIn(<SignInPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in is not configured on this server. Contact support.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('4: when the providers request fails, Salesforce sign-in still shows (the server answers sign_in_disabled if it is off)', async () => {
    stubApi({ [PROVIDERS]: respond(500, { error: 'boom', code: 'INTERNAL' }) });
    renderSignIn(<SignInPage />);
    expect(await screen.findByRole('button', { name: 'Sign in with Salesforce' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sign in with email' })).not.toBeInTheDocument();
  });
});
