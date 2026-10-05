import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { LIST_VIEW_ID, campaign, preview } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { CampaignBuilder } from './campaign-builder';

afterEach(() => vi.unstubAllGlobals());

const leadViews = { listViews: [{ id: LIST_VIEW_ID, label: 'Hot leads', developerName: 'Hot_Leads' }] };

describe('CampaignBuilder', () => {
  it('previews a list view: total, eligible of the first N checked, every skip reason in words, and the sample', async () => {
    const calls = stubApi({ 'GET /api/crm/listviews?object=Lead': leadViews, 'POST /api/campaigns/preview': preview() });
    renderWithProviders(<CampaignBuilder onCreated={vi.fn()} />, { isAdmin: true });
    await screen.findByRole('option', { name: 'Hot leads' });
    await userEvent.selectOptions(screen.getByLabelText('Salesforce list view'), LIST_VIEW_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Of the first 2,000 checked: 1,500 eligible')).toBeInTheDocument();
    expect(screen.getByText('4,210 records match.')).toBeInTheDocument();
    const skipped = screen.getByRole('list', { name: 'Skipped records by reason' });
    expect(within(skipped).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'No phone or email: 120',
      'Opted out: 40',
      'On the block list: 5',
      'On the national Do Not Call list: 60',
      'Salesforce Do Not Call: 90',
      'Salesforce Email Opt Out: 10',
      'Skip on Dialer: 75',
      'Already in another active campaign: 80',
      'Closed or converted: 20',
    ]);
    const sample = screen.getByRole('table', { name: 'Sample records' });
    expect(within(sample).getByText('Jane Seller')).toBeInTheDocument();
    expect(within(sample).getByText('Call, Text')).toBeInTheDocument();
    expect(within(sample).getByText('Skipped: No phone or email')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ sfObject: 'Lead', source: { kind: 'list_view', listViewId: LIST_VIEW_ID } });
  });

  it('shows a 422 INVALID_SOURCE inline with the Salesforce message', async () => {
    stubApi({
      'GET /api/crm/listviews?object=Lead': leadViews,
      'POST /api/campaigns/preview': respond(422, { error: "unexpected token: 'FORM'", code: 'INVALID_SOURCE', details: { code: 'salesforce_error' } }),
    });
    renderWithProviders(<CampaignBuilder onCreated={vi.fn()} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('tab', { name: 'SOQL' }));
    await userEvent.type(screen.getByLabelText('SOQL query'), "SELECT Id FORM Lead WHERE Status = 'Open'");
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Salesforce can't use this source: unexpected token: 'FORM'");
    expect(screen.queryByText(/eligible/)).not.toBeInTheDocument();
  });

  it('creates the campaign from the chosen object and list view and hands it to onCreated', async () => {
    const onCreated = vi.fn();
    const created = campaign({ status: 'draft', sfObject: 'Opportunity', name: 'Stale opps' });
    const calls = stubApi({
      'GET /api/crm/listviews?object=Lead': leadViews,
      'GET /api/crm/listviews?object=Opportunity': { listViews: [{ id: LIST_VIEW_ID, label: 'Old opps', developerName: 'Old_Opps' }] },
      'POST /api/campaigns': created,
    });
    renderWithProviders(<CampaignBuilder onCreated={onCreated} />, { isAdmin: true });
    await userEvent.type(screen.getByLabelText('Campaign name'), 'Stale opps');
    await userEvent.selectOptions(screen.getByLabelText('Salesforce object'), 'Opportunity');
    await screen.findByRole('option', { name: 'Old opps' });
    await userEvent.selectOptions(screen.getByLabelText('Salesforce list view'), LIST_VIEW_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Stale opps', sfObject: 'Opportunity', mode: 'sequence', source: { kind: 'list_view', listViewId: LIST_VIEW_ID } });
  });

  it('defaults to a sequence campaign: Create hands the campaign over at once, with no lead picker', async () => {
    const onCreated = vi.fn();
    const created = campaign({ status: 'draft' });
    stubApi({ 'GET /api/crm/listviews?object=Lead': leadViews, 'POST /api/campaigns': created });
    renderWithProviders(<CampaignBuilder onCreated={onCreated} />, { isAdmin: true });
    expect(screen.getByLabelText('What the campaign does')).toHaveValue('sequence');
    await userEvent.type(screen.getByLabelText('Campaign name'), 'Spring sellers');
    await screen.findByRole('option', { name: 'Hot leads' });
    await userEvent.selectOptions(screen.getByLabelText('Salesforce list view'), LIST_VIEW_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(screen.queryByText('Leads to call')).not.toBeInTheDocument();
  });

  it('an AI calls campaign is created first, then the picker is shown; Continue hands it to onCreated', async () => {
    const onCreated = vi.fn();
    const created = campaign({ status: 'draft', mode: 'ai_call' });
    const calls = stubApi({
      'GET /api/crm/listviews?object=Lead': leadViews,
      'POST /api/campaigns': created,
      [`GET /api/campaigns/${created.id}/candidates?page=1`]: { total: 1, page: 1, pageSize: 50, pages: 1, selectedCount: 0, records: [{ sfRecordId: '00Q000000000001AAA', name: 'Jane Seller', ownerName: 'Rep One', consentAiCall: true, skipReason: null, selected: false, enrolled: false }] },
    });
    renderWithProviders(<CampaignBuilder onCreated={onCreated} />, { isAdmin: true });
    await userEvent.selectOptions(screen.getByLabelText('What the campaign does'), 'ai_call');
    await userEvent.type(screen.getByLabelText('Campaign name'), 'Past sellers');
    await screen.findByRole('option', { name: 'Hot leads' });
    await userEvent.selectOptions(screen.getByLabelText('Salesforce list view'), LIST_VIEW_ID);
    await userEvent.click(screen.getByRole('button', { name: 'Create campaign' }));
    expect(await screen.findByText('Leads to call')).toBeInTheDocument();
    expect(await screen.findByText('Jane Seller')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ mode: 'ai_call', name: 'Past sellers' });
    expect(screen.queryByRole('button', { name: 'Create campaign' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to campaign' }));
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('keeps Preview and Create disabled until a source is chosen', async () => {
    stubApi({ 'GET /api/crm/listviews?object=Lead': leadViews });
    renderWithProviders(<CampaignBuilder onCreated={vi.fn()} />, { isAdmin: true });
    await userEvent.type(screen.getByLabelText('Campaign name'), 'Spring sellers');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create campaign' })).toBeDisabled();
  });

  it('says so when Salesforce is not connected', async () => {
    stubApi({ 'GET /api/crm/listviews?object=Lead': respond(409, { error: 'Salesforce is not connected', code: 'CRM_NOT_CONNECTED' }) });
    renderWithProviders(<CampaignBuilder onCreated={vi.fn()} />, { isAdmin: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Salesforce is not connected. An admin can connect it in Settings.');
  });

  it('tells members that only admins create campaigns', () => {
    stubApi({});
    renderWithProviders(<CampaignBuilder onCreated={vi.fn()} />);
    expect(screen.getByText('Only admins can create campaigns.')).toBeInTheDocument();
  });
});
