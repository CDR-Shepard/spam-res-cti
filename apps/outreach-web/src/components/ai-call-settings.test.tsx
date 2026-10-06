import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiCallSettings } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { respond, stubApi, type StubCall } from '../test/stub-api';
import { AiCallSettingsCard } from './ai-call-settings';

const GRANT = '0058X00000Fsx39QAB';
const PAT = '0058X00000Abcd1QAB';
const SAM = '0058X00000Zzzz9QAB';
const grant = { id: GRANT, name: 'Grant Golden', title: 'Acquisitions', isActive: true };
const pat = { id: PAT, name: 'Pat Doe', title: null, isActive: true };
const sam = { id: SAM, name: 'Sam Gone', title: null, isActive: false };

/** A tenant that turned booking, conversion and write-back on, with the configured default owner list (Grant Golden). */
function settings(over: Partial<AiCallSettings['booking']> = {}, writeback = true): AiCallSettings {
  return {
    booking: {
      enabled: true,
      specialists: [GRANT],
      convertLeads: true,
      days: [1, 2, 3, 4, 5],
      phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
      walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
      ...over,
    },
    writeback,
  };
}
const idsUrl = (ids: string[]) => `GET /api/salesforce/users?${new URLSearchParams({ ids: ids.join(',') }).toString()}`;
const puts = (calls: StubCall[]) => calls.filter((c) => c.method === 'PUT' && c.url === '/api/settings/ai-calls').map((c) => c.body as AiCallSettings);
const owners = () => within(screen.getByRole('list', { name: 'Appointment owners' })).getAllByRole('listitem');
const BOOKING_OFF = 'Booking is off: nobody active on the list';

afterEach(() => vi.unstubAllGlobals());

describe('AiCallSettingsCard', () => {
  it('renders nothing for a non-admin and asks for nothing', async () => {
    const calls = stubApi({});
    const { container } = renderWithProviders(<AiCallSettingsCard />);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('renders a turned-on tenant', async () => {
    stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant] });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByRole('checkbox', { name: 'Book appointments on AI calls' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Convert a Lead that books an appointment' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Write call results back to Salesforce' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Offer phone calls' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Offer walkthroughs' })).toBeChecked();
    expect(screen.getByLabelText('Phone call length (minutes)')).toHaveValue(15);
    expect(screen.getByLabelText('Phone call from (hour, 24h)')).toHaveValue(10);
    expect(screen.getByLabelText('Phone call until (hour, 24h)')).toHaveValue(18);
    expect(screen.getByLabelText('Phone call earliest (hours ahead)')).toHaveValue(2);
    expect(screen.getByLabelText('Phone call latest (business days ahead)')).toHaveValue(2);
    expect(screen.getByLabelText('Walkthrough length (minutes)')).toHaveValue(60);
    expect(screen.getByLabelText('Walkthrough earliest (hours ahead)')).toHaveValue(20);
    expect(screen.getByLabelText('Walkthrough latest (business days ahead)')).toHaveValue(5);
    expect(screen.getByText('Every AI-booked appointment goes to the first active person on this list. They distribute them.')).toBeInTheDocument();
  });

  it('final review WEB I-2: a tenant that never turned them on sees booking, conversion and write-back off, and when to turn them on', async () => {
    stubApi({ 'GET /api/settings/ai-calls': settings({ enabled: false, convertLeads: false }, false), [idsUrl([GRANT])]: [grant] });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByRole('checkbox', { name: 'Book appointments on AI calls' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Convert a Lead that books an appointment' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Write call results back to Salesforce' })).not.toBeChecked();
    expect(screen.getByText(/start off for every tenant/)).toHaveTextContent(
      'Booking, Lead conversion and Salesforce write-back start off for every tenant, and these switches apply to every AI call campaign. Turn them on only after the readiness check below says Ready, a practice call sounds right, and a one-Lead live check was written back correctly.',
    );
  });

  it('the default list from the server shows Grant Golden first, and booking is on', async () => {
    stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [GRANT, SAM] }), [idsUrl([GRANT, SAM])]: [grant, sam] });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await screen.findByText('Grant Golden');
    expect(owners()[0]).toHaveTextContent('Grant Golden');
    expect(owners()[1]).toHaveTextContent('Sam Gone (inactive)');
    expect(within(owners()[1]!).getByText('Sam Gone (inactive)')).toHaveClass('text-destructive');
    expect(screen.queryByText(BOOKING_OFF)).not.toBeInTheDocument();
  });

  it('adding a person from a search result and saving PUTs the new ordered list', async () => {
    const calls = stubApi({
      'GET /api/settings/ai-calls': settings(),
      [idsUrl([GRANT])]: [grant],
      'GET /api/salesforce/users?search=Pat': [grant, pat],
      'PUT /api/settings/ai-calls': settings({ specialists: [GRANT, PAT] }),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await screen.findByText('Grant Golden');
    await userEvent.type(screen.getByLabelText('Find a Salesforce user'), 'Pat');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    // Someone already on the list is not offered again.
    await userEvent.click(await screen.findByRole('button', { name: 'Add Pat Doe' }));
    expect(screen.queryByRole('button', { name: 'Add Grant Golden' })).not.toBeInTheDocument();
    expect(owners().map((li) => li.textContent)).toEqual([expect.stringContaining('Grant Golden'), expect.stringContaining('Pat Doe')]);
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toEqual(settings({ specialists: [GRANT, PAT] }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('reorders and removes people; the order is what is saved', async () => {
    const calls = stubApi({
      'GET /api/settings/ai-calls': settings({ specialists: [GRANT, PAT, SAM] }),
      [idsUrl([GRANT, PAT, SAM])]: [grant, pat, sam],
      'PUT /api/settings/ai-calls': settings({ specialists: [PAT, GRANT] }),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await screen.findByText('Pat Doe');
    await userEvent.click(screen.getByRole('button', { name: 'Move Pat Doe up' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Sam Gone' }));
    expect(screen.getByRole('button', { name: 'Move Pat Doe up' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]!.booking.specialists).toEqual([PAT, GRANT]);
  });

  it('an empty list shows the booking-is-off line', async () => {
    const calls = stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [] }) });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByText(BOOKING_OFF)).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/api/salesforce/users'))).toBe(false);
  });

  it('a list whose only user is inactive shows the booking-is-off line; removing the last active person shows it too', async () => {
    stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [SAM] }), [idsUrl([SAM])]: [sam] });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByText(BOOKING_OFF)).toBeInTheDocument();
  });

  it('the line appears once the last active person is removed', async () => {
    stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [GRANT, SAM] }), [idsUrl([GRANT, SAM])]: [grant, sam] });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await screen.findByText('Grant Golden');
    expect(screen.queryByText(BOOKING_OFF)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Grant Golden' }));
    expect(screen.getByText(BOOKING_OFF)).toBeInTheDocument();
  });

  describe('Fix 1 (M-3): an id the lookup did not return', () => {
    it('shows "(not found)" in red and counts as nobody active', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT] }), [idsUrl([PAT])]: [] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      const label = await screen.findByText(`${PAT} (not found)`);
      expect(label).toHaveClass('text-destructive');
      expect(screen.getByText(BOOKING_OFF)).toBeInTheDocument();
    });

    it('beside an inactive user still turns booking off; beside an active one it does not', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT, SAM] }), [idsUrl([PAT, SAM])]: [sam] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(`${PAT} (not found)`)).toBeInTheDocument();
      expect(screen.getByText('Sam Gone (inactive)')).toBeInTheDocument();
      expect(screen.getByText(BOOKING_OFF)).toBeInTheDocument();
    });

    it('a found active user keeps booking on', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT, GRANT] }), [idsUrl([PAT, GRANT])]: [grant] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(`${PAT} (not found)`)).toBeInTheDocument();
      expect(screen.queryByText(BOOKING_OFF)).not.toBeInTheDocument();
    });

    it('when the lookup fails, an unknown id is neither "not found" nor booking off (nobody knows yet)', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT] }), [idsUrl([PAT])]: respond(502, { error: 'Salesforce did not answer', code: 'CRM_ERROR' }) });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(PAT)).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText(/./, { selector: 'p.text-destructive' }).length).toBeGreaterThan(0));
      expect(screen.queryByText(`${PAT} (not found)`)).not.toBeInTheDocument();
      expect(screen.queryByText(BOOKING_OFF)).not.toBeInTheDocument();
    });
  });

  it('turning "Convert a Lead…" off PUTs convertLeads: false; write-back off PUTs writeback: false', async () => {
    const calls = stubApi({
      'GET /api/settings/ai-calls': settings(),
      [idsUrl([GRANT])]: [grant],
      'PUT /api/settings/ai-calls': settings({ convertLeads: false }, false),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Convert a Lead that books an appointment' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Write call results back to Salesforce' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toEqual(settings({ convertLeads: false }, false));
  });

  it('edits a kind\'s hours and lead time; an end hour not after the start hour cannot be saved', async () => {
    const calls = stubApi({
      'GET /api/settings/ai-calls': settings(),
      [idsUrl([GRANT])]: [grant],
      'PUT /api/settings/ai-calls': settings(),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    const until = await screen.findByLabelText('Walkthrough until (hour, 24h)');
    await userEvent.clear(until);
    await userEvent.type(until, '9');
    expect(screen.getByRole('button', { name: 'Save AI call settings' })).toBeDisabled();
    expect(screen.getByText(/each kind needs an end hour after its start hour/)).toBeInTheDocument();
    await userEvent.clear(until);
    await userEvent.type(until, '16');
    const earliest = screen.getByLabelText('Walkthrough earliest (hours ahead)');
    await userEvent.clear(earliest);
    await userEvent.type(earliest, '24');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Offer phone calls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const sent = puts(calls)[0]!.booking;
    expect(sent.walkthrough).toMatchObject({ endHour: 16, minLeadMinutes: 1440 });
    expect(sent.phone.enabled).toBe(false);
  });

  it('a refused save shows why and keeps the edits', async () => {
    stubApi({
      'GET /api/settings/ai-calls': settings(),
      [idsUrl([GRANT])]: [grant],
      'PUT /api/settings/ai-calls': respond(400, { error: 'Those AI call settings are not valid.', code: 'INVALID_BODY' }),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Book appointments on AI calls' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    expect(await screen.findByText('Those AI call settings are not valid.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Book appointments on AI calls' })).not.toBeChecked();
  });

  it('a search without Salesforce says so', async () => {
    stubApi({
      'GET /api/settings/ai-calls': settings({ specialists: [] }),
      'GET /api/salesforce/users?search=Pat': respond(409, { error: 'Connect Salesforce in Settings → Connections first', code: 'CRM_NOT_CONNECTED' }),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await userEvent.type(await screen.findByLabelText('Find a Salesforce user'), 'Pat');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Salesforce is not connected. An admin can connect it in Settings.')).toBeInTheDocument();
  });
});

describe('Salesforce write-back readiness', () => {
  const READINESS = 'GET /api/settings/ai-calls/readiness';
  const base = { [`GET /api/settings/ai-calls`]: settings(), [idsUrl([GRANT])]: [grant] };
  const ready = {
    ready: true,
    convertReady: true,
    convertRecordTypes: { account: 'Person Account', opportunity: 'Homeowner Opportunity' },
    appointmentOwner: { id: GRANT, name: 'Grant Golden', title: null, isActive: true },
    items: [],
  };

  it('a ready org says Ready, who appointments go to, and what conversion creates', async () => {
    stubApi({ ...base, [READINESS]: ready });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByRole('heading', { name: 'Salesforce write-back readiness' })).toBeInTheDocument();
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Appointments go to: Grant Golden')).toBeInTheDocument();
    expect(screen.getByText('Lead conversion: ready. New records will be Person Account / Homeowner Opportunity')).toBeInTheDocument();
  });

  it('lists each problem in words; conversion not ready names why and the fallback; nobody active turns booking off', async () => {
    stubApi({
      ...base,
      [READINESS]: {
        ...ready,
        ready: false,
        convertReady: false,
        appointmentOwner: null,
        items: [
          { object: 'Lead', field: 'AI_Last_Call_Changes__c', label: 'AI Last Call Changes', problem: 'not_updateable' },
          { object: 'Opportunity', field: 'Loss_Reason__c', label: 'Loss_Reason__c', problem: 'missing' },
          { object: 'Event', field: null, label: 'Event', problem: 'cannot_create' },
          { object: 'Lead', field: null, label: 'Convert Leads permission', problem: 'cannot_convert' },
        ],
      },
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    const list = within(await screen.findByRole('list', { name: 'Write-back problems' }));
    expect(list.getByText("Lead · AI Last Call Changes: the connected Salesforce user can't edit it")).toBeInTheDocument();
    expect(list.getByText("Opportunity · Loss_Reason__c: not in this Salesforce org, or hidden from the connected user")).toBeInTheDocument();
    expect(list.getByText("Event: can't be created by the connected user")).toBeInTheDocument();
    expect(screen.getByText('Appointments go to: nobody active: booking is off')).toBeInTheDocument();
    expect(
      screen.getByText("Lead conversion: not ready (Convert Leads permission: the connected Salesforce user doesn't have it). A Lead that books gets a calendar hold and a Task instead"),
    ).toBeInTheDocument();
  });

  it('a readiness check that cannot run says why', async () => {
    stubApi({ ...base, [READINESS]: respond(409, { error: 'Salesforce is not connected.', code: 'CRM_NOT_CONNECTED' }) });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByText('Salesforce is not connected. An admin can connect it in Settings.')).toBeInTheDocument();
  });
});
