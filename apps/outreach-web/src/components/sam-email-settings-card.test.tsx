import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { samEmailSettings } from '../test/seller-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { SamEmailSettingsCard } from './sam-email-settings-card';

afterEach(() => vi.unstubAllGlobals());

const GET = 'GET /api/settings/sam-email';
const PUT = 'PUT /api/settings/sam-email';
const admin = () => renderWithProviders(<SamEmailSettingsCard />, { isAdmin: true });
const emailSwitch = () => screen.findByRole('switch', { name: 'Email from Sam' });

describe('SamEmailSettingsCard', () => {
  it('shows the switch as the tenant has it', async () => {
    stubApi({ [GET]: samEmailSettings({ enabled: true }) });
    admin();
    expect(await emailSwitch()).toBeChecked();
    expect(screen.queryByText('Resend is not set up yet')).not.toBeInTheDocument();
  });

  it('turning it on saves enabled: true and shows the saved state', async () => {
    const calls = stubApi({ [GET]: samEmailSettings(), [PUT]: samEmailSettings({ enabled: true }) });
    admin();
    const toggle = await emailSwitch();
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ url: '/api/settings/sam-email', method: 'PUT', body: { enabled: true } });
  });

  it('turning it off saves enabled: false', async () => {
    const calls = stubApi({ [GET]: samEmailSettings({ enabled: true }), [PUT]: samEmailSettings({ enabled: false }) });
    admin();
    const toggle = await emailSwitch();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false });
  });

  it('the switch is disabled, with the reason, when the server is not set up', async () => {
    const calls = stubApi({ [GET]: samEmailSettings({ configured: false }) });
    admin();
    const toggle = await emailSwitch();
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription('Resend is not set up yet');
    expect(screen.getByText('Resend is not set up yet')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('can still be turned off when the server is not set up; only turning it on needs the setup', async () => {
    const calls = stubApi({ [GET]: samEmailSettings({ configured: false, enabled: true }), [PUT]: samEmailSettings({ configured: false, enabled: false }) });
    admin();
    const toggle = await emailSwitch();
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ url: '/api/settings/sam-email', method: 'PUT', body: { enabled: false } });
    // Off again, the setup is what is missing: it cannot be turned back on.
    expect(toggle).toBeDisabled();
    expect(screen.getByText('Resend is not set up yet')).toBeInTheDocument();
  });

  it('says when a spam complaint paused it, and shows the switch off until it is turned back on', async () => {
    const calls = stubApi({
      [GET]: samEmailSettings({ enabled: true, pausedAt: '2026-10-05T18:30:00.000Z', pausedReason: 'complaint' }),
      [PUT]: samEmailSettings({ enabled: true }),
    });
    admin();
    const toggle = await emailSwitch();
    const date = new Date('2026-10-05T18:30:00.000Z').toLocaleDateString('en-US', { dateStyle: 'medium' });
    expect(screen.getByText(`Paused after a spam complaint on ${date}. Turn it back on when you're ready.`)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText(/Paused after a spam complaint/)).not.toBeInTheDocument());
    expect(toggle).toBeChecked();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true });
  });

  it('shows a pause the server could not date without a date', async () => {
    stubApi({ [GET]: samEmailSettings({ pausedAt: '1970-01-01T00:00:00.000Z' }) });
    admin();
    await emailSwitch();
    expect(screen.getByText("Paused after a spam complaint. Turn it back on when you're ready.")).toBeInTheDocument();
  });

  it('says why a save was refused, and leaves the switch as it was', async () => {
    stubApi({ [GET]: samEmailSettings(), [PUT]: respond(409, { error: 'long server words', code: 'EMAIL_NOT_CONFIGURED' }) });
    admin();
    const toggle = await emailSwitch();
    await userEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('Email from Sam is not set up on this server yet.');
    expect(toggle).not.toBeChecked();
  });

  it('says so when the settings cannot be read', async () => {
    stubApi({ [GET]: respond(500, { error: 'Something went wrong on our side. Try again in a minute.', code: 'INTERNAL_ERROR' }) });
    admin();
    expect(await screen.findByText('Something went wrong on our side. Try again in a minute.')).toBeInTheDocument();
  });

  it('is for admins: it shows a member nothing and asks the server nothing', () => {
    const calls = stubApi({ [GET]: samEmailSettings() });
    const { container } = renderWithProviders(<SamEmailSettingsCard />, { isAdmin: false });
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
  });
});
