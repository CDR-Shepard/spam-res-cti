import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test/render';
import { CAMPAIGN_ID, campaign } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { CampaignDetail } from './campaign-detail';

afterEach(() => vi.unstubAllGlobals());

describe('CampaignDetail', () => {
  it('shows the campaign name, status, source, and member count', async () => {
    stubApi({ [`GET /api/campaigns/${CAMPAIGN_ID}`]: campaign() });
    renderWithRouter(<CampaignDetail campaignId={CAMPAIGN_ID} />);
    expect(await screen.findByRole('heading', { name: 'Spring sellers' })).toBeInTheDocument();
    expect(screen.getByText('Dry run')).toBeInTheDocument();
    expect(screen.getByText(/Leads from a Salesforce list view · 1,250 members/)).toBeInTheDocument();
  });

  it('says when the campaign does not exist', async () => {
    stubApi({ [`GET /api/campaigns/${CAMPAIGN_ID}`]: respond(404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' }) });
    renderWithRouter(<CampaignDetail campaignId={CAMPAIGN_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('That campaign does not exist.');
  });
});
