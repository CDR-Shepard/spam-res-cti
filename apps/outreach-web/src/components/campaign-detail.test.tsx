import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CampaignStatus } from '@cti/contracts';
import { renderWithRouter } from '../test/render';
import { CAMPAIGN_ID, campaign } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { CampaignDetail } from './campaign-detail';

afterEach(() => vi.unstubAllGlobals());

const CAMPAIGN = `/api/campaigns/${CAMPAIGN_ID}`;
const emptyPlan = { rows: [], nextCursor: null, counts: {} };

function renderDetail(routes: Record<string, unknown>, isAdmin = true) {
  const calls = stubApi({ [`GET ${CAMPAIGN}/plan`]: emptyPlan, ...routes });
  renderWithRouter(<CampaignDetail campaignId={CAMPAIGN_ID} />, { isAdmin });
  return calls;
}

describe('CampaignDetail header', () => {
  it('shows the campaign name, status, source, and member count', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign() });
    expect(await screen.findByRole('heading', { name: 'Spring sellers' })).toBeInTheDocument();
    expect(screen.getByText('Dry run')).toBeInTheDocument();
    expect(screen.getByText(/Leads from a Salesforce list view · 1,250 members/)).toBeInTheDocument();
  });

  it('says when the campaign does not exist', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: respond(404, { error: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('That campaign does not exist.');
  });

  const allowed: Array<[CampaignStatus, string[]]> = [
    ['draft', ['Start dry run']],
    ['dry_run', ['Go live', 'Pause', 'Archive']],
    ['active', ['Pause', 'Archive']],
    ['paused', ['Resume', 'Start dry run', 'Archive']],
    ['archived', []],
  ];
  it.each(allowed)('offers an admin only the allowed status changes from %s', async (status, labels) => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status, pauseReason: status === 'paused' ? 'manual' : null }) });
    await screen.findByRole('heading', { name: 'Spring sellers' });
    const group = screen.queryByRole('group', { name: 'Change status' });
    expect(group ? within(group).getAllByRole('button').map((b) => b.textContent) : []).toEqual(labels);
  });

  it('offers members no status changes', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign() }, false);
    await screen.findByRole('heading', { name: 'Spring sellers' });
    expect(screen.queryByRole('group', { name: 'Change status' })).not.toBeInTheDocument();
  });

  it('asks before going live, then posts the change and shows the new status', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign(), [`POST ${CAMPAIGN}/status`]: campaign({ status: 'active' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Go live' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent("Calls will start appearing in reps' Campaign calls list.");
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ status: 'active' }));
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('cancelling the go-live dialog changes nothing', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign() });
    await userEvent.click(await screen.findByRole('button', { name: 'Go live' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('pauses without a dialog', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'active' }), [`POST ${CAMPAIGN}/status`]: campaign({ status: 'paused', pauseReason: 'manual' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ status: 'paused' }));
    expect(await screen.findByText('Paused by an admin')).toBeInTheDocument();
  });

  it('explains a rejected transition', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'active' }), [`POST ${CAMPAIGN}/status`]: respond(409, { error: 'bad', code: 'BAD_TRANSITION' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("That change isn't allowed from the campaign's current status.");
  });
});

describe('CampaignDetail banners', () => {
  it.each([
    ['manual', 'Paused by an admin'],
    ['crm_broken', 'Paused: the Salesforce connection needs to be reconnected'],
    ['ai_budget', "Paused: today's AI budget is used up — resumes tomorrow"],
    ['kill_switch', 'Paused: outreach is switched off'],
  ])('words the %s pause', async (reason, words) => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'paused', pauseReason: reason }) }, false);
    expect(await screen.findByRole('status')).toHaveTextContent(words);
  });

  it('shows the last refresh error', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'active', lastRefreshError: 'INVALID_FIELD: No such column Motivation__c' }) }, false);
    expect(await screen.findByRole('alert')).toHaveTextContent('The last Salesforce refresh failed: INVALID_FIELD: No such column Motivation__c');
  });
});

describe('CampaignDetail settings', () => {
  it('lets an admin change the refresh interval and touch days', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign(), [`PATCH ${CAMPAIGN}`]: campaign({ refreshMinutes: 120, touchDays: [0, 2, 5] }) });
    const refresh = await screen.findByLabelText('Refresh every (minutes)');
    await userEvent.clear(refresh);
    await userEvent.type(refresh, '120');
    const days = screen.getByLabelText('Touch days');
    await userEvent.clear(days);
    await userEvent.type(days, '0, 2, 5');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ refreshMinutes: 120, touchDays: [0, 2, 5] }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('refuses touch days that do not start at 0 and go up', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign() });
    const days = await screen.findByLabelText('Touch days');
    await userEvent.clear(days);
    await userEvent.type(days, '1, 3, 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Touch days must start at 0 and go up');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows members the settings read-only', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign() }, false);
    expect(await screen.findByText('Checks Salesforce every 240 minutes. Touches on days 0, 1, 3, 6, 10, 14.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });
});
