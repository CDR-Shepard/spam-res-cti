import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiCallSettings, RoutingReadiness } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { respond, stubApi, type StubCall } from '../test/stub-api';
import { AiCallSettingsCard } from './ai-call-settings';

const GRANT = '0058X00000Fsx39QAB';
const PAT = '0058X00000Abcd1QAB';
const SAM = '0058X00000Zzzz9QAB';
const grant = { id: GRANT, name: 'Grant Golden', title: 'Acquisitions', isActive: true };
const pat = { id: PAT, name: 'Pat Doe', title: null, isActive: true };
const sam = { id: SAM, name: 'Sam Gone', title: null, isActive: false };
// Staff (the spec's region reps): their names are fine to show.
const chance = { id: '0055f000005qXn8AAE', name: 'Chance Lanier', title: null, isActive: true };
const blake = { id: '0058X00000FA8tLQAT', name: 'Blake Kossuth', title: null, isActive: true };
const seth = { id: '0055f000005qXVfAAM', name: 'Seth Boisvert', title: null, isActive: true };
const thomas = { id: '0055f000005qYO6AAM', name: 'Thomas Wilkinson', title: null, isActive: true };
const OFFICE = '18872 MacArthur Blvd #220, Irvine, CA 92612';
const SD_START = '7480 Miramar Rd, San Diego, CA';
const ROUTING: RoutingReadiness = {
  officeAddress: OFFICE,
  mapsConfigured: true,
  regions: [
    { key: 'LA', counties: ['Los Angeles', 'Orange', 'Riverside', 'San Bernardino'], startTimes: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'], startAddress: OFFICE, reps: [chance, blake] },
    { key: 'SD', counties: ['San Diego'], startTimes: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'], startAddress: SD_START, reps: [seth, thomas] },
  ],
};

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
const owners = () => within(screen.getByRole('list', { name: 'High-priority appointments go to' })).getAllByRole('listitem');
const BOOKING_OFF = 'No high-priority bookings: nobody active on the list';
const OWNER_LINE =
  'Sellers who need to sell fast, or face a foreclosure or auction, are booked with the first active person on this list at the time they ask for, whatever their calendar says. Every other appointment goes to the region\'s reps below.';
const MAPS_MISSING = 'Google Maps key missing: no appointment times are offered until GOOGLE_MAPS_API_KEY is set on outreach-api.';
const READINESS = 'GET /api/settings/ai-calls/readiness';
const READY = {
  ready: true,
  convertReady: true,
  convertRecordTypes: { account: 'Person Account', opportunity: 'Homeowner Opportunity' },
  appointmentOwner: { id: GRANT, name: 'Grant Golden', title: null, isActive: true },
  items: [],
};

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
    expect(screen.getByRole('checkbox', { name: 'Convert a Lead that books an appointment' })).toHaveAccessibleDescription(
      'Off: every Lead booking is kept on the Lead with a hold and a Task for the booked rep.',
    );
    expect(screen.getByRole('checkbox', { name: 'Write call results back to Salesforce' })).toBeChecked();
    expect(screen.getByRole('heading', { name: 'High-priority appointments go to' })).toBeInTheDocument();
    expect(screen.getByText(OWNER_LINE)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Phone consultations' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'In-person consultations' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Offer phone consultations' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Offer in-person consultations' })).toBeChecked();
    expect(screen.getByLabelText('Phone consultation earliest (hours ahead)')).toHaveValue(2);
    expect(screen.getByLabelText('Phone consultation latest (business days ahead)')).toHaveValue(2);
    expect(screen.getByLabelText('In-person consultation earliest (hours ahead)')).toHaveValue(20);
    expect(screen.getByLabelText('In-person consultation latest (business days ahead)')).toHaveValue(5);
    // The region table sets the length and the start times: the card no longer edits them.
    expect(screen.queryByLabelText(/length \(minutes\)/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/from \(hour, 24h\)/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/until \(hour, 24h\)/)).not.toBeInTheDocument();
  });

  // The server ignores the routing a save sends back (the region table is defined in code), so only these are asserted here.
  it('ruling: a save sends the saved length, from and until unchanged', async () => {
    const base = settings();
    const saved = settings({
      phone: { ...base.booking.phone, durationMinutes: 25, startHour: 8, endHour: 12 },
      walkthrough: { ...base.booking.walkthrough, durationMinutes: 90, startHour: 7, endHour: 21 },
    });
    const calls = stubApi({ 'GET /api/settings/ai-calls': saved, [idsUrl([GRANT])]: [grant], 'PUT /api/settings/ai-calls': saved });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Convert a Lead that books an appointment' }));
    const earliest = screen.getByLabelText('Phone consultation earliest (hours ahead)');
    await userEvent.clear(earliest);
    await userEvent.type(earliest, '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const sent = puts(calls)[0]!;
    expect(sent).toEqual({ ...saved, booking: { ...saved.booking, convertLeads: false, phone: { ...saved.booking.phone, minLeadMinutes: 180 } } });
    expect(sent.booking.phone).toMatchObject({ durationMinutes: 25, startHour: 8, endHour: 12 });
    expect(sent.booking.walkthrough).toMatchObject({ durationMinutes: 90, startHour: 7, endHour: 21 });
  });

  describe('the regions (read-only, from the readiness check)', () => {
    const regions = () => screen.findByRole('table', { name: 'Booking regions' });
    /** The body row whose row header (the Region cell) is `key`. */
    const rowOf = async (key: string): Promise<HTMLElement> =>
      within(await regions()).getByRole('rowheader', { name: key }).closest('tr') as HTMLElement;

    it('shows each region under the owner list: counties, reps, start times in Pacific, and the office', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant], [READINESS]: { ...READY, routing: ROUTING } });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      const table = await regions();
      expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Region', 'Counties', 'Reps', 'Starts (Pacific)']);
      const owners = screen.getByRole('heading', { name: 'High-priority appointments go to' });
      expect(owners.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const la = within(await rowOf('LA'));
      expect(la.getByText('LA')).toBeInTheDocument();
      expect(la.getByText('Los Angeles, Orange, Riverside, San Bernardino')).toBeInTheDocument();
      expect(la.getByText('Chance Lanier')).toBeInTheDocument();
      expect(la.getByText('Blake Kossuth')).toBeInTheDocument();
      expect(la.getByText('9 AM, 11 AM, 1 PM, 3 PM, 5 PM, 7 PM')).toBeInTheDocument();
      const sd = within(await rowOf('SD'));
      expect(sd.getByText('San Diego')).toBeInTheDocument();
      expect(sd.getByText('Seth Boisvert')).toBeInTheDocument();
      expect(sd.getByText('Thomas Wilkinson')).toBeInTheDocument();
      expect(sd.getByText('9 AM, 10 AM, 11 AM, 12 PM, 1 PM, 2 PM, 3 PM, 4 PM')).toBeInTheDocument();
      expect(screen.getByText(`LA reps start from ${OFFICE}.`)).toBeInTheDocument();
      expect(screen.getByText(`SD reps start from ${SD_START}.`)).toBeInTheDocument();
      expect(screen.queryByText(MAPS_MISSING)).not.toBeInTheDocument();
    });

    it('marks an inactive rep "inactive", and says a time off the hour with its minutes', async () => {
      const routing = { ...ROUTING, regions: [{ ...ROUTING.regions[0]!, startTimes: ['00:00', '09:30', '12:15'], reps: [chance, { ...blake, isActive: false }] }] };
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant], [READINESS]: { ...READY, routing } });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      const la = within(await rowOf('LA'));
      expect(la.getByText('Blake Kossuth (inactive)')).toHaveClass('text-destructive');
      expect(la.getByText('Chance Lanier')).not.toHaveClass('text-destructive');
      expect(la.getByText('12 AM, 9:30 AM, 12:15 PM')).toBeInTheDocument();
    });

    it('a region with no active rep says no times are offered there, in red', async () => {
      const routing = {
        ...ROUTING,
        regions: [
          ROUTING.regions[0]!,
          { ...ROUTING.regions[1]!, reps: [{ ...seth, isActive: false }, { ...thomas, isActive: false }] },
          { key: 'IE', counties: ['Invented'], startTimes: ['10:00'], reps: [] },
        ],
      };
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant], [READINESS]: { ...READY, routing } });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText('No active rep: no SD times are offered.')).toHaveClass('text-destructive');
      expect(screen.getByText('No active rep: no IE times are offered.')).toHaveClass('text-destructive');
      // An outreach-api older than the region starts sends none: the region reads as starting from the office.
      expect(screen.getByText(`IE reps start from ${OFFICE}.`)).toBeInTheDocument();
      expect(screen.queryByText('No active rep: no LA times are offered.')).not.toBeInTheDocument();
      const table = screen.getByRole('table', { name: 'Booking regions' });
      expect(table.compareDocumentPosition(screen.getByText('No active rep: no SD times are offered.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('without a Google Maps key says so in red', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant], [READINESS]: { ...READY, routing: { ...ROUTING, mapsConfigured: false } } });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(MAPS_MISSING)).toHaveClass('text-destructive');
      expect(screen.getByRole('table', { name: 'Booking regions' })).toBeInTheDocument();
    });

    it('an answer without routing (an older outreach-api) shows no table', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant], [READINESS]: READY });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText('High-priority appointments go to: Grant Golden')).toBeInTheDocument();
      expect(screen.queryByRole('table', { name: 'Booking regions' })).not.toBeInTheDocument();
    });
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

  it('the default list from the server shows Grant Golden first, and high-priority bookings are on', async () => {
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
    // final review m8: an edit after saving is not saved, and the page stops saying so.
    await userEvent.click(screen.getByRole('button', { name: 'Remove Pat Doe' }));
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
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

  it('an empty list shows the no-high-priority line', async () => {
    const calls = stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [] }) });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByText(BOOKING_OFF)).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith('/api/salesforce/users'))).toBe(false);
  });

  it('a list whose only user is inactive shows the no-high-priority line', async () => {
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

    it('beside an inactive user still means nobody active', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT, SAM] }), [idsUrl([PAT, SAM])]: [sam] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(`${PAT} (not found)`)).toBeInTheDocument();
      expect(screen.getByText('Sam Gone (inactive)')).toBeInTheDocument();
      expect(screen.getByText(BOOKING_OFF)).toBeInTheDocument();
    });

    it('a found active user keeps high-priority bookings on', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ specialists: [PAT, GRANT] }), [idsUrl([PAT, GRANT])]: [grant] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByText(`${PAT} (not found)`)).toBeInTheDocument();
      expect(screen.queryByText(BOOKING_OFF)).not.toBeInTheDocument();
    });

    it('when the lookup fails, an unknown id is neither "not found" nor nobody active (nobody knows yet)', async () => {
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
      'PUT /api/settings/ai-calls': settings({ convertLeads: false, enabled: false }, false),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Convert a Lead that books an appointment' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Write call results back to Salesforce' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    // Fix 2: turning write-back off turns booking off in the same save.
    expect(puts(calls)[0]).toEqual(settings({ convertLeads: false, enabled: false }, false));
  });

  describe('fix 2: booking needs write-back', () => {
    const BOOK = { name: 'Book appointments on AI calls' };
    const WRITE = { name: 'Write call results back to Salesforce' };
    const HINT = 'Turn on Salesforce write-back first';

    it('with write-back off the booking checkbox is unticked and disabled, with the hint; with it on there is no hint', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings({ enabled: false }, false), [idsUrl([GRANT])]: [grant] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      const book = await screen.findByRole('checkbox', BOOK);
      expect(book).toBeDisabled();
      expect(book).not.toBeChecked();
      expect(book).toHaveAccessibleDescription(HINT);
      expect(screen.getByText(HINT)).toBeInTheDocument();
    });

    it('ticking write-back enables booking, and booking and write-back save together', async () => {
      const calls = stubApi({
        'GET /api/settings/ai-calls': settings({ enabled: false }, false),
        [idsUrl([GRANT])]: [grant],
        'PUT /api/settings/ai-calls': settings(),
      });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      await userEvent.click(await screen.findByRole('checkbox', WRITE));
      expect(screen.getByRole('checkbox', BOOK)).toBeEnabled();
      expect(screen.queryByText(HINT)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('checkbox', BOOK));
      await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
      await waitFor(() => expect(puts(calls)).toHaveLength(1));
      expect(puts(calls)[0]).toEqual(settings());
    });

    it('unticking write-back unticks booking and disables it; ticking write-back again does not bring booking back', async () => {
      stubApi({ 'GET /api/settings/ai-calls': settings(), [idsUrl([GRANT])]: [grant] });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      expect(await screen.findByRole('checkbox', BOOK)).toBeChecked();
      await userEvent.click(screen.getByRole('checkbox', WRITE));
      expect(screen.getByRole('checkbox', BOOK)).not.toBeChecked();
      expect(screen.getByRole('checkbox', BOOK)).toBeDisabled();
      await userEvent.click(screen.getByRole('checkbox', WRITE));
      expect(screen.getByRole('checkbox', BOOK)).not.toBeChecked();
      expect(screen.getByRole('checkbox', BOOK)).toBeEnabled();
    });

    it('a saved blob with booking on and write-back off (before the rule) is shown, and saved, as booking off', async () => {
      const calls = stubApi({
        'GET /api/settings/ai-calls': settings({ enabled: true }, false),
        [idsUrl([GRANT])]: [grant],
        'PUT /api/settings/ai-calls': settings({ enabled: false }, false),
      });
      renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
      const book = await screen.findByRole('checkbox', BOOK);
      expect(book).not.toBeChecked();
      expect(book).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
      await waitFor(() => expect(puts(calls)).toHaveLength(1));
      expect(puts(calls)[0]!.booking.enabled).toBe(false);
    });
  });

  it('edits a kind\'s earliest and latest; a value out of range cannot be saved', async () => {
    const calls = stubApi({
      'GET /api/settings/ai-calls': settings(),
      [idsUrl([GRANT])]: [grant],
      'PUT /api/settings/ai-calls': settings(),
    });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    const latest = await screen.findByLabelText('In-person consultation latest (business days ahead)');
    await userEvent.clear(latest);
    await userEvent.type(latest, '11');
    expect(screen.getByRole('button', { name: 'Save AI call settings' })).toBeDisabled();
    expect(screen.getByText('Check the numbers: every value must be in range.')).toBeInTheDocument();
    await userEvent.clear(latest);
    await userEvent.type(latest, '7');
    const earliest = screen.getByLabelText('In-person consultation earliest (hours ahead)');
    await userEvent.clear(earliest);
    await userEvent.type(earliest, '24');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Offer phone consultations' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save AI call settings' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const sent = puts(calls)[0]!.booking;
    expect(sent.walkthrough).toMatchObject({ horizonBusinessDays: 7, minLeadMinutes: 1440 });
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
  const base = { [`GET /api/settings/ai-calls`]: settings(), [idsUrl([GRANT])]: [grant] };
  const ready = READY;

  it('a ready org says Ready, who high-priority appointments go to, and what conversion creates', async () => {
    stubApi({ ...base, [READINESS]: ready });
    renderWithProviders(<AiCallSettingsCard />, { isAdmin: true });
    expect(await screen.findByRole('heading', { name: 'Salesforce write-back readiness' })).toBeInTheDocument();
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('High-priority appointments go to: Grant Golden')).toBeInTheDocument();
    expect(screen.getByText('Lead conversion: ready. New records will be Person Account / Homeowner Opportunity')).toBeInTheDocument();
  });

  it('lists each problem in words; conversion not ready names why and the fallback; nobody active for high priority', async () => {
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
    expect(screen.getByText('High-priority appointments go to: nobody active')).toBeInTheDocument();
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
