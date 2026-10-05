import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { CAMPAIGN_ID, OTHER_ENROLLMENT_ID, planRow } from '../test/outreach-fixtures';
import { stubApi } from '../test/stub-api';
import { CampaignPlan } from './campaign-plan';

afterEach(() => vi.unstubAllGlobals());

const PLAN = `/api/campaigns/${CAMPAIGN_ID}/plan`;
const stopped = planRow({ enrollmentId: OTHER_ENROLLMENT_ID, sfRecordId: '00Q5e00000Abc02', name: 'Sam Gone', ownerName: null, status: 'exited', exitReason: 'left_query', triage: null, nextTouch: null });

describe('CampaignPlan', () => {
  it('shows counts by status and a row per person with triage summary and next touch', async () => {
    stubApi({ [`GET ${PLAN}`]: { rows: [planRow(), stopped], nextCursor: null, counts: { active: 1, exited: 1 } } });
    renderWithProviders(<CampaignPlan campaignId={CAMPAIGN_ID} />);
    const counts = await screen.findByRole('list', { name: 'People by status' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'In sequence 1', 'In conversation 0', 'Needs review 0', 'Handed off 0', 'Finished 0', 'Stopped 1',
    ]);
    const jane = screen.getByText('Jane Seller').closest('tr') as HTMLElement;
    expect(within(jane).getByText('Rep One')).toBeInTheDocument();
    expect(within(jane).getByText('In sequence')).toBeInTheDocument();
    expect(within(jane).getByText('Inherited a vacant house and wants it gone before winter.')).toBeInTheDocument();
    expect(within(jane).getByText(/^Rep call · .+ · planned$/)).toBeInTheDocument();
    const sam = screen.getByText('Sam Gone').closest('tr') as HTMLElement;
    expect(within(sam).getByText('Stopped: left the Salesforce query')).toBeInTheDocument();
    expect(within(sam).getByText('Not triaged yet')).toBeInTheDocument();
  });

  it('expands a row to show the triage reasons and the gate audit in plain words', async () => {
    stubApi({ [`GET ${PLAN}`]: { rows: [planRow()], nextCursor: null, counts: { active: 1 } } });
    renderWithProviders(<CampaignPlan campaignId={CAMPAIGN_ID} />);
    const toggle = await screen.findByRole('button', { name: 'Details for Jane Seller' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Gate checks for Jane Seller' })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const audit = screen.getByRole('list', { name: 'Gate checks for Jane Seller' });
    expect(within(audit).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Text ruled out: No mobile number on the record',
      'Rep call kept: No AI-call consent, so a rep makes this call',
      'Rep call moved later: A rep dialed this person yesterday, so it waits a day',
    ]);
    const reasons = screen.getByRole('list', { name: 'Triage reasons for Jane Seller' });
    expect(reasons).toHaveTextContent('Call: "Call me after 5, I\'m at work"');
    expect(screen.getByText('Timing: after 5pm')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByRole('list', { name: 'Gate checks for Jane Seller' })).not.toBeInTheDocument();
  });

  it('loads the next page with the cursor and appends its rows', async () => {
    const calls = stubApi({
      [`GET ${PLAN}`]: { rows: [planRow()], nextCursor: 'cur-2', counts: { active: 1, exited: 1 } },
      [`GET ${PLAN}?cursor=cur-2`]: { rows: [stopped], nextCursor: null, counts: { active: 1, exited: 1 } },
    });
    renderWithProviders(<CampaignPlan campaignId={CAMPAIGN_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Sam Gone')).toBeInTheDocument();
    expect(screen.getByText('Jane Seller')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual([PLAN, `${PLAN}?cursor=cur-2`]);
  });

  it('says when nobody is enrolled yet', async () => {
    stubApi({ [`GET ${PLAN}`]: { rows: [], nextCursor: null, counts: {} } });
    renderWithProviders(<CampaignPlan campaignId={CAMPAIGN_ID} />);
    expect(await screen.findByText('Nobody is enrolled yet. People join on the next refresh.')).toBeInTheDocument();
  });
});
