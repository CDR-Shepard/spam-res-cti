import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { getAiAvailability, outreachKeys } from '../lib/outreach-api';
import { renderWithProviders } from '../test/render';
import { respond, stubApi, type StubCall } from '../test/stub-api';
import { ADDED_AT, PHONE_A, PHONE_B, phonesResponse, testPhone } from '../test/testing-fixtures';
import { formatDateTime } from '../lib/outreach-words';
import { TestPhonesCard } from './test-phones-card';

afterEach(() => vi.unstubAllGlobals());

const LIST = 'GET /api/testing/phones';
const ADD = 'POST /api/testing/phones';
const REMOVE_A = `DELETE /api/testing/phones/${PHONE_A}`;
const TEST_CALL = 'POST /api/ai-calls/test';
const CALL_ID = '99999999-9999-4999-8999-999999999999';
const GRANT = testPhone();
const SAM = testPhone({ id: PHONE_B, e164: '+16195550102', label: '', addedByEmail: null });

const sent = (calls: StubCall[], route: string) => calls.filter((c) => `${c.method} ${c.url}` === route);

async function render(routes: Record<string, unknown> = {}) {
  if (!(LIST in routes)) routes[LIST] = phonesResponse(GRANT, SAM);
  const calls = stubApi(routes);
  const view = renderWithProviders(<TestPhonesCard />, { isAdmin: true });
  return { calls, routes, ...view };
}
const rowOf = (name: RegExp | string) => screen.getByRole('listitem', { name });

describe('TestPhonesCard: the list', () => {
  it('explains the list and who may be on it', async () => {
    await render();
    expect(await screen.findByRole('heading', { name: 'Test phones' })).toBeInTheDocument();
    expect(screen.getByText("Phones on this list can get test calls from the agent, and when they call one of the agent's numbers, the agent answers.")).toBeInTheDocument();
    expect(screen.getByText('Only add phones whose owners agreed to get test calls from the agent.')).toBeInTheDocument();
  });

  it('shows each phone formatted, with its label and who added it', async () => {
    await render();
    const grant = await screen.findByRole('listitem', { name: /Grant cell/ });
    expect(within(grant).getByText('(619) 555-0123')).toBeInTheDocument();
    expect(within(grant).getByText('Grant cell')).toBeInTheDocument();
    expect(within(grant).getByText(`Added by grant@gghomes.com · ${formatDateTime(ADDED_AT)}`)).toBeInTheDocument();
    const sam = rowOf('(619) 555-0102');
    expect(within(sam).getByText('(619) 555-0102')).toBeInTheDocument();
    expect(within(sam).getByText(`Added ${formatDateTime(ADDED_AT)}`)).toBeInTheDocument();
  });

  it('says so when there are no phones yet', async () => {
    await render({ [LIST]: phonesResponse() });
    expect(await screen.findByText('No test phones yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows the error when the list cannot be read', async () => {
    await render({ [LIST]: respond(403, { error: 'Admin access required', code: 'ADMIN_ONLY' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admins can do that.');
  });
});

describe('TestPhonesCard: adding a phone', () => {
  it('sends what was typed, then shows the new list and clears the form', async () => {
    const user = userEvent.setup();
    const { calls, routes } = await render({ [LIST]: phonesResponse(), [ADD]: respond(201, GRANT) });
    await screen.findByText('No test phones yet.');
    await user.type(screen.getByLabelText('Phone'), '(619) 555-0123');
    await user.type(screen.getByLabelText('Label (optional)'), 'Grant cell');
    routes[LIST] = phonesResponse(GRANT);
    await user.click(screen.getByRole('button', { name: 'Add phone' }));
    expect(await screen.findByText('(619) 555-0123')).toBeInTheDocument();
    expect(sent(calls, ADD)[0]?.body).toEqual({ phone: '(619) 555-0123', label: 'Grant cell' });
    expect(screen.getByLabelText('Phone')).toHaveValue('');
    expect(screen.getByLabelText('Label (optional)')).toHaveValue('');
  });

  it('Add phone waits for a phone to be typed', async () => {
    const user = userEvent.setup();
    await render({ [LIST]: phonesResponse() });
    await screen.findByText('No test phones yet.');
    expect(screen.getByRole('button', { name: 'Add phone' })).toBeDisabled();
    await user.type(screen.getByLabelText('Phone'), '   ');
    expect(screen.getByRole('button', { name: 'Add phone' })).toBeDisabled();
    await user.type(screen.getByLabelText('Phone'), '619');
    expect(screen.getByRole('button', { name: 'Add phone' })).toBeEnabled();
  });

  it.each([
    [400, 'INVALID_PHONE', "That doesn't look like a phone number"],
    [409, 'PHONE_ALREADY_LISTED', 'That phone is already on the list'],
    [400, 'LIST_FULL', 'The list is full (25 phones) — remove one first'],
  ])("a %s %s answer shows the server's sentence inline, and keeps what was typed", async (status, code, words) => {
    const user = userEvent.setup();
    const { calls } = await render({ [LIST]: phonesResponse(), [ADD]: respond(status, { error: words, code }) });
    await screen.findByText('No test phones yet.');
    await user.type(screen.getByLabelText('Phone'), 'abc');
    await user.type(screen.getByLabelText('Label (optional)'), 'Sam');
    await user.click(screen.getByRole('button', { name: 'Add phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(screen.getByLabelText('Phone')).toHaveValue('abc');
    expect(screen.getByLabelText('Label (optional)')).toHaveValue('Sam');
    expect(sent(calls, LIST)).toHaveLength(1);
  });

  it('an old error goes away when the next add starts', async () => {
    const user = userEvent.setup();
    const { routes } = await render({ [LIST]: phonesResponse(), [ADD]: respond(400, { error: "That doesn't look like a phone number", code: 'INVALID_PHONE' }) });
    await screen.findByText('No test phones yet.');
    await user.type(screen.getByLabelText('Phone'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Add phone' }));
    await screen.findByRole('alert');
    routes[ADD] = respond(201, GRANT);
    await user.click(screen.getByRole('button', { name: 'Add phone' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('a label is held to 60 characters in the box', async () => {
    await render({ [LIST]: phonesResponse() });
    expect(await screen.findByLabelText('Label (optional)')).toHaveAttribute('maxlength', '60');
  });
});

describe('TestPhonesCard: removing a phone', () => {
  it('asks first; cancelling removes nothing', async () => {
    const user = userEvent.setup();
    const { calls } = await render();
    await user.click(await screen.findByRole('button', { name: 'Remove Grant cell (619) 555-0123' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove this phone?');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(sent(calls, REMOVE_A)).toEqual([]);
    expect(screen.getByText('Grant cell')).toBeInTheDocument();
  });

  it('confirming removes it and shows the list again', async () => {
    const user = userEvent.setup();
    const { calls, routes } = await render({ [REMOVE_A]: respond(204) });
    await user.click(await screen.findByRole('button', { name: 'Remove Grant cell (619) 555-0123' }));
    routes[LIST] = phonesResponse(SAM);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText('Grant cell')).not.toBeInTheDocument());
    expect(sent(calls, REMOVE_A)).toHaveLength(1);
    expect(screen.getByText('(619) 555-0102')).toBeInTheDocument();
  });

  it('a failed removal shows its sentence and leaves the phone on the list', async () => {
    const user = userEvent.setup();
    await render({ [REMOVE_A]: respond(404, { error: 'No such phone on the list.', code: 'NOT_FOUND' }) });
    await user.click(await screen.findByRole('button', { name: 'Remove Grant cell (619) 555-0123' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No such phone on the list.');
    expect(screen.getByText('Grant cell')).toBeInTheDocument();
  });
});

describe('TestPhonesCard: Call this phone', () => {
  it('has the agent call that phone, through the existing test call, and says it is calling', async () => {
    const user = userEvent.setup();
    const { calls } = await render({ [TEST_CALL]: { result: 'placed', aiCallId: CALL_ID } });
    await user.click(await screen.findByRole('button', { name: 'Call this phone: Grant cell (619) 555-0123' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Calling Grant cell now. Pick up to hear the agent.');
    expect(sent(calls, TEST_CALL)).toEqual([expect.objectContaining({ body: { to: '+16195550123' } })]);
  });

  it('a phone with no label is named by its number', async () => {
    const user = userEvent.setup();
    await render({ [TEST_CALL]: { result: 'placed', aiCallId: CALL_ID } });
    await user.click(await screen.findByRole('button', { name: 'Call this phone: (619) 555-0102' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Calling (619) 555-0102 now. Pick up to hear the agent.');
  });

  it('a refusal says why, in the words the other test calls use', async () => {
    const user = userEvent.setup();
    await render({ [TEST_CALL]: { result: 'blocked', reason: 'calling_hours', aiCallId: CALL_ID } });
    await user.click(await screen.findByRole('button', { name: 'Call this phone: Grant cell (619) 555-0123' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Not called: outside calling hours where they live');
  });

  it('a 502 shows the error text', async () => {
    const user = userEvent.setup();
    await render({ [TEST_CALL]: respond(502, { error: 'The AI calling service did not answer. Try again in a minute.', code: 'CTI_UNREACHABLE' }) });
    await user.click(await screen.findByRole('button', { name: 'Call this phone: Grant cell (619) 555-0123' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The AI calling service did not answer. Try again in a minute.');
  });

  it("the answer is shown under that phone's row only", async () => {
    const user = userEvent.setup();
    await render({ [TEST_CALL]: { result: 'placed', aiCallId: CALL_ID } });
    await user.click(await screen.findByRole('button', { name: 'Call this phone: Grant cell (619) 555-0123' }));
    const status = await screen.findByRole('status');
    expect(within(rowOf(/Grant cell/)).getByRole('status')).toBe(status);
    expect(within(rowOf('(619) 555-0102')).queryByRole('status')).not.toBeInTheDocument();
  });
});

/** Stands in for the other test-call cards (Test call to my phone, Practice, Test a record): they read the same query. */
function AvailabilityProbe() {
  const availability = useQuery({ queryKey: outreachKeys.aiAvailability, queryFn: getAiAvailability });
  return <p>{`Test numbers: ${availability.data?.testNumbers.length ?? '…'}`}</p>;
}

describe("TestPhonesCard: the other test-call cards' phone lists follow the list (final review I-1)", () => {
  const AVAILABILITY = 'GET /api/ai-calls/availability';

  /** `routes` is the live stub table: a test changes answers after the page is up. */
  async function renderWithProbe(routes: Record<string, unknown>) {
    if (!(AVAILABILITY in routes)) routes[AVAILABILITY] = { available: true, testNumbers: [] };
    const calls = stubApi(routes);
    renderWithProviders(<><TestPhonesCard /><AvailabilityProbe /></>, { isAdmin: true });
    await screen.findByText('Test numbers: 0');
    return calls;
  }

  it('adding a phone refreshes the test numbers the other cards offer', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = { [LIST]: phonesResponse(), [ADD]: respond(201, GRANT) };
    const calls = await renderWithProbe(routes);
    await screen.findByText('No test phones yet.');
    routes[AVAILABILITY] = { available: true, testNumbers: ['+16195550123'] };
    routes[LIST] = phonesResponse(GRANT);
    await user.type(screen.getByLabelText('Phone'), '(619) 555-0123');
    await user.click(screen.getByRole('button', { name: 'Add phone' }));
    expect(await screen.findByText('Test numbers: 1')).toBeInTheDocument();
    expect(sent(calls, AVAILABILITY)).toHaveLength(2);
  });

  it('removing a phone refreshes them too', async () => {
    const user = userEvent.setup();
    const routes: Record<string, unknown> = { [LIST]: phonesResponse(GRANT, SAM), [REMOVE_A]: respond(204) };
    const calls = await renderWithProbe(routes);
    await user.click(await screen.findByRole('button', { name: 'Remove Grant cell (619) 555-0123' }));
    routes[LIST] = phonesResponse(SAM);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent(calls, AVAILABILITY)).toHaveLength(2));
  });
});
