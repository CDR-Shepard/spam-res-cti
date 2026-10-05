import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test/render';
import { CAMPAIGN_ID, campaign } from '../test/outreach-fixtures';
import { stubApi } from '../test/stub-api';
import { CampaignsPage } from './campaigns-page';

afterEach(() => vi.unstubAllGlobals());

const SECOND_ID = '33333333-3333-4333-8333-333333333333';

describe('CampaignsPage', () => {
  it('lists campaigns with object, status, members, refresh time, and the pause reason in words', async () => {
    stubApi({
      'GET /api/campaigns': {
        campaigns: [
          campaign(),
          campaign({ id: SECOND_ID, name: 'Stale opps', sfObject: 'Opportunity', status: 'paused', pauseReason: 'crm_broken', memberCount: 12, lastRefreshedAt: null }),
        ],
      },
    });
    renderWithRouter(<CampaignsPage />, { isAdmin: true });
    const spring = (await screen.findByRole('link', { name: 'Spring sellers' })).closest('tr') as HTMLElement;
    expect(within(spring).getByText('Leads')).toBeInTheDocument();
    expect(within(spring).getByText('Dry run')).toBeInTheDocument();
    expect(within(spring).getByText('1,250')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spring sellers' })).toHaveAttribute('href', `/campaigns/${CAMPAIGN_ID}`);
    const stale = screen.getByRole('link', { name: 'Stale opps' }).closest('tr') as HTMLElement;
    expect(within(stale).getByText('Opportunities')).toBeInTheDocument();
    expect(within(stale).getByText('Paused: the Salesforce connection needs to be reconnected')).toBeInTheDocument();
    expect(within(stale).getByText('Never')).toBeInTheDocument();
  });

  it('shows New campaign to admins only', async () => {
    stubApi({ 'GET /api/campaigns': { campaigns: [] } });
    renderWithRouter(<CampaignsPage />);
    expect(await screen.findByText('No campaigns yet.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New campaign' })).not.toBeInTheDocument();
  });

  it('asks for the list including archived campaigns when the box is ticked', async () => {
    const calls = stubApi({ 'GET /api/campaigns': { campaigns: [] }, 'GET /api/campaigns?archived=1': { campaigns: [campaign({ status: 'archived' })] } });
    renderWithRouter(<CampaignsPage />, { isAdmin: true });
    expect(await screen.findByRole('link', { name: 'New campaign' })).toHaveAttribute('href', '/campaigns/new');
    await userEvent.click(screen.getByLabelText('Include archived'));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/api/campaigns?archived=1'));
  });
});
