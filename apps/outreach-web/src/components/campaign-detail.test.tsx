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
    ['draft', ['Start dry run', 'Archive']],
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

  it('a campaign paused from its dry run leads with "Resume dry run", then offers going live', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'paused', pauseReason: 'ai_budget', pausedFrom: 'dry_run' }) });
    await screen.findByRole('heading', { name: 'Spring sellers' });
    const group = screen.getByRole('group', { name: 'Change status' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Resume dry run', 'Go live', 'Archive']);
  });

  it('a campaign paused while live leads with "Resume" (going live again, after a dialog)', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'paused', pauseReason: 'manual', pausedFrom: 'active' }) });
    await screen.findByRole('heading', { name: 'Spring sellers' });
    const group = screen.getByRole('group', { name: 'Change status' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Resume', 'Start dry run', 'Archive']);
  });

  it('"Resume dry run" posts dry_run without a dialog', async () => {
    const calls = renderDetail({
      [`GET ${CAMPAIGN}`]: campaign({ status: 'paused', pauseReason: 'manual', pausedFrom: 'dry_run' }),
      [`POST ${CAMPAIGN}/status`]: campaign({ status: 'dry_run' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Resume dry run' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ status: 'dry_run' }));
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

  it('reloads the plan after a status change', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ status: 'active' }), [`POST ${CAMPAIGN}/status`]: campaign({ status: 'paused', pauseReason: 'manual' }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused by an admin');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === `${CAMPAIGN}/plan`).length).toBeGreaterThanOrEqual(2));
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
    ['ai_budget', "Paused: today's AI budget is used up — it does not resume on its own: press Resume after midnight UTC or raise the budget"],
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

  it('reloads the plan after the settings are saved', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign(), [`PATCH ${CAMPAIGN}`]: campaign({ refreshMinutes: 120 }) });
    const refresh = await screen.findByLabelText('Refresh every (minutes)');
    await userEvent.clear(refresh);
    await userEvent.type(refresh, '120');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved.');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === `${CAMPAIGN}/plan`).length).toBeGreaterThanOrEqual(2));
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

describe('CampaignDetail of an AI call campaign', () => {
  const candidates = { total: 1, page: 1, pageSize: 50, pages: 1, selectedCount: 0, activeEnrolledCount: 0, records: [{ sfRecordId: '00Q000000000001AAA', name: 'Jane Seller', ownerName: 'Rep One', consentAiCall: true, skipReason: null, selected: false, enrolled: false, enrollmentStatus: null, exitReason: null }] };

  const emptyBoard = { cards: [], nextCursor: null, counts: { research: 0, review: 0, approved: 0, queued: 0, done: 0 } };

  it('shows the lead picker and the call plan board instead of the sequence plan', async () => {
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ mode: 'ai_call' }), [`GET ${CAMPAIGN}/candidates?page=1`]: candidates, [`GET ${CAMPAIGN}/call-plans`]: emptyBoard });
    expect(await screen.findByText('Leads to call')).toBeInTheDocument();
    expect(await screen.findByText('Call plans')).toBeInTheDocument();
    expect(calls.some((c) => c.url === `${CAMPAIGN}/call-plans`)).toBe(true);
    expect(await screen.findByText('Jane Seller')).toBeInTheDocument();
    expect(screen.queryByText('Plan')).not.toBeInTheDocument();
    expect(calls.some((c) => c.url === `${CAMPAIGN}/plan`)).toBe(false);
  });

  it('shows the AI call results under the board', async () => {
    const results = { items: [{ touchId: '00000000-0000-4000-8000-000000000001', enrollmentId: '00000000-0000-4000-8000-000000000002', name: 'Jane Seller', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', recordUrl: null, touchStatus: 'failed', dueAt: '2026-10-05T22:00:00.000Z', attempts: 1, lastBlockReason: 'no_consent', aiCallId: null, callStatus: null, outcome: null, summary: null, qualification: null, durationSeconds: null, startedAt: null, enrollmentStatus: 'exited', exitReason: 'ai_call_no_consent', mayReadTranscript: false, appointment: null, writeback: null }], nextCursor: null };
    const calls = renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ mode: 'ai_call' }), [`GET ${CAMPAIGN}/candidates?page=1`]: candidates, [`GET ${CAMPAIGN}/call-plans`]: emptyBoard, [`GET ${CAMPAIGN}/ai-calls`]: results });
    expect(await screen.findByText('AI calls')).toBeInTheDocument();
    expect(await screen.findByText('Not called: no AI consent in Salesforce')).toBeInTheDocument();
    expect(calls.some((c) => c.url === `${CAMPAIGN}/ai-calls`)).toBe(true);
  });

  it('says what a dry run does for AI calls', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ mode: 'ai_call', status: 'dry_run' }), [`GET ${CAMPAIGN}/candidates?page=1`]: candidates });
    expect(await screen.findByRole('status')).toHaveTextContent('Dry run: picked leads are researched and call plans are written for review. No calls are placed.');
  });

  it('a sequence campaign keeps the sequence plan and its dry-run banner', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ mode: 'sequence', status: 'dry_run' }) });
    expect(await screen.findByRole('status')).toHaveTextContent('Dry run: the plan below shows what would happen. Nothing is sent and no calls are queued.');
    expect(screen.queryByText('Leads to call')).not.toBeInTheDocument();
    expect(screen.queryByText('AI calls')).not.toBeInTheDocument();
  });

  it('lets a member see the picker but not change it', async () => {
    renderDetail({ [`GET ${CAMPAIGN}`]: campaign({ mode: 'ai_call' }), [`GET ${CAMPAIGN}/candidates?page=1`]: candidates }, false);
    expect(await screen.findByRole('checkbox', { name: 'Select Jane Seller' })).toBeDisabled();
  });
});

