import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CandidatePage, CandidateRecord } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { CAMPAIGN_ID } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { LeadPicker } from './lead-picker';

afterEach(() => vi.unstubAllGlobals());

const CANDIDATES = `/api/campaigns/${CAMPAIGN_ID}/candidates`;
const SELECTION = `/api/campaigns/${CAMPAIGN_ID}/selection`;
const sfId = (n: number) => `00Q${String(n).padStart(15, '0')}`;

function rec(n: number, over: Partial<CandidateRecord> = {}): CandidateRecord {
  return { sfRecordId: sfId(n), name: `Lead ${n}`, ownerName: 'Rep One', consentAiCall: false, skipReason: null, selected: false, enrolled: false, ...over };
}
function page(over: Partial<CandidatePage> = {}): CandidatePage {
  return {
    total: 120, page: 1, pageSize: 50, pages: 3, selectedCount: 3,
    records: [rec(1, { consentAiCall: true, selected: true }), rec(2), rec(3, { skipReason: 'opted_out' }), rec(4, { enrolled: true, selected: true })],
    ...over,
  };
}
const selectionBody = (calls: ReturnType<typeof stubApi>) => calls.filter((c) => c.method === 'PUT').map((c) => c.body);
const put = { selectedCount: 4, ignored: 0 };

describe('LeadPicker', () => {
  it('shows the count line and one row per record with its name, owner and consent', async () => {
    stubApi({ [`GET ${CANDIDATES}?page=1`]: page() });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    expect(await screen.findByText('120 records match · 3 selected')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Matching records' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Lead 1')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Rep One')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('AI consent')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('No AI consent')).toBeInTheDocument();
  });

  it("ticking a row sends { add: [id] }, unticking { remove: [id] }, and the page is read again", async () => {
    const calls = stubApi({ [`GET ${CANDIDATES}?page=1`]: page(), [`PUT ${SELECTION}`]: put });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Lead 2' }));
    await waitFor(() => expect(selectionBody(calls)).toEqual([{ add: [sfId(2)] }]));
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url === `${CANDIDATES}?page=1`)).toHaveLength(2));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Lead 1' }));
    await waitFor(() => expect(selectionBody(calls)).toEqual([{ add: [sfId(2)] }, { remove: [sfId(1)] }]));
  });

  it('"Select this page" adds the selectable rows; skipped and enrolled rows cannot be ticked and say why', async () => {
    const calls = stubApi({ [`GET ${CANDIDATES}?page=1`]: page(), [`PUT ${SELECTION}`]: put });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    await screen.findByText('120 records match · 3 selected');
    expect(screen.getByRole('checkbox', { name: 'Select Lead 3' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Lead 4' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Lead 4' })).toBeChecked();
    expect(screen.getByText('Skipped: Opted out')).toBeInTheDocument();
    expect(screen.getByText('Enrolled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Select this page' }));
    await waitFor(() => expect(selectionBody(calls)).toEqual([{ add: [sfId(2)] }]));
  });

  it('"Select this page" is disabled when nothing on the page is left to add', async () => {
    stubApi({ [`GET ${CANDIDATES}?page=1`]: page({ records: [rec(1, { selected: true }), rec(3, { skipReason: 'blocked' })] }) });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    await screen.findByText('120 records match · 3 selected');
    expect(screen.getByRole('button', { name: 'Select this page' })).toBeDisabled();
  });

  it('"Select all 120" sends { selectAll: true } and "Clear" sends { clear: true }', async () => {
    const calls = stubApi({ [`GET ${CANDIDATES}?page=1`]: page(), [`PUT ${SELECTION}`]: put });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Select all 120' }));
    await waitFor(() => expect(selectionBody(calls)).toEqual([{ selectAll: true }]));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(selectionBody(calls)).toEqual([{ selectAll: true }, { clear: true }]));
  });

  it('Next and Previous request the neighbouring page; each is disabled at its end', async () => {
    const calls = stubApi({
      [`GET ${CANDIDATES}?page=1`]: page(),
      [`GET ${CANDIDATES}?page=2`]: page({ page: 2 }),
      [`GET ${CANDIDATES}?page=3`]: page({ page: 3 }),
    });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    await screen.findByText('Page 1 of 3');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    expect(calls.some((c) => c.url === `${CANDIDATES}?page=2`)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 3 of 3');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Page 2 of 3');
    expect(calls.filter((c) => c.url === `${CANDIDATES}?page=2`).length).toBeGreaterThanOrEqual(1);
  });

  it('disables every checkbox and selection button when canEdit is false', async () => {
    stubApi({ [`GET ${CANDIDATES}?page=1`]: page() });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit={false} />);
    await screen.findByText('120 records match · 3 selected');
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    for (const name of ['Select this page', 'Select all 120', 'Clear']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('shows a 422 INVALID_SOURCE error verbatim in an alert', async () => {
    stubApi({ [`GET ${CANDIDATES}?page=1`]: respond(422, { error: 'The query returns more than 50,000 records. Narrow the query.', code: 'INVALID_SOURCE' }) });
    renderWithProviders(<LeadPicker campaignId={CAMPAIGN_ID} canEdit />, { isAdmin: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('The query returns more than 50,000 records. Narrow the query.');
  });
});
