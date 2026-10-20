import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { RECORD_URL, SELLER_ID, callItem, emailItem, noteItem, rowId, sellerView } from '../test/seller-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { SellerConversationPage } from './seller-conversation-page';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error jsdom does not define it: put it back the way it was.
  delete Element.prototype.scrollIntoView;
});

const CONV = `/api/sellers/${SELLER_ID}/conversation`;
const HANDLER = `/api/sellers/${SELLER_ID}/handler`;

const page = (focusEventId: string | null = null, opts: { isAdmin?: boolean } = {}) =>
  renderWithProviders(<SellerConversationPage sfRecordId={SELLER_ID} focusEventId={focusEventId} />, { isAdmin: false, ...opts });

describe('SellerConversationPage: the timeline', () => {
  it('renders a call, an inbound email and a note as three rows, oldest first', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView() });
    page();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Jane Seller');
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.id)).toEqual([`event-${rowId(1)}`, `event-${rowId(2)}`, `event-${rowId(3)}`]);
    expect(within(rows[0]!).getByText('AI call')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Email from the seller')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/Taken over by Dana/)).toBeInTheDocument();
  });

  it('says so while it loads and when the seller cannot be read', async () => {
    stubApi({ [`GET ${CONV}`]: respond(403, { error: "Only the record's owner in Salesforce or an admin can see or change this seller.", code: 'FORBIDDEN' }) });
    page();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("Only the record's owner in Salesforce or an admin can see or change this seller.");
  });

  it('keeps the page when a later refresh fails, and says so', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      reads += 1;
      const failed = reads > 1;
      return new Response(JSON.stringify(failed ? { error: 'The server is busy.', code: 'INTERNAL_ERROR' } : sellerView()), { status: failed ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    }));
    page();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Jane Seller');
    // Coming back to the tab refetches a stale page.
    window.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh this page. The server is busy.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Jane Seller');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('opens a #event link on that row', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView() });
    page(rowId(2));
    await screen.findByRole('heading', { level: 1 });
    expect(document.getElementById(`event-${rowId(2)}`)).toHaveAttribute('data-highlighted', 'true');
  });
});

describe('SellerConversationPage: the header', () => {
  it('shows the name linked to the Salesforce record, and a status badge', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView() });
    page();
    const link = await screen.findByRole('link', { name: 'Jane Seller' });
    expect(link).toHaveAttribute('href', RECORD_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByText('Talking with Sam')).toBeInTheDocument();
  });

  it('shows the name without a link when the tenant has no Salesforce connection; a record with no name shows its id', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView({ recordUrl: '', name: SELLER_ID }) });
    page();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(SELLER_ID);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each([
    ['taken over', { handler: 'person', handlerName: 'Dana' }, 'Taken over by Dana'],
    ['booked', { status: 'booked' }, 'Booked'],
    ['stopped', { status: 'stopped', stopReason: 'asked_to_stop' }, 'Stopped (asked Sam to stop)'],
    ['flagged', { flagReason: 'wants_appointment' }, 'Needs a person (wants to set a time)'],
  ] as const)('badge: %s', async (_name, over, label) => {
    stubApi({ [`GET ${CONV}`]: sellerView(over) });
    page();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });
});

describe('SellerConversationPage: taking over and giving back', () => {
  it('Take over calls the handler route with "person", then shows the answer', async () => {
    const calls = stubApi({
      [`GET ${CONV}`]: sellerView(),
      [`PUT ${HANDLER}`]: sellerView({ handler: 'person', handlerName: 'Admin', items: [noteItem({ id: rowId(4), detail: 'taken_over', byName: 'Admin' })] }),
    });
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(await screen.findByText('Taken over by Admin', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ url: HANDLER, method: 'PUT', body: { handler: 'person' } });
    expect(screen.getByRole('button', { name: 'Give back to Sam' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
  });

  it('Give back to Sam calls the handler route with "sam"', async () => {
    const calls = stubApi({
      [`GET ${CONV}`]: sellerView({ handler: 'person', handlerName: 'Dana' }),
      [`PUT ${HANDLER}`]: sellerView(),
    });
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Give back to Sam' }));
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ handler: 'sam' });
  });

  it('the give-back button says it clears the flag when the seller is flagged', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView({ handler: 'person', handlerName: 'Dana', flagReason: 'legal' }) });
    page();
    expect(await screen.findByRole('button', { name: 'Clear flag and give back to Sam' })).toBeInTheDocument();
  });

  it('shows neither button to someone who may not change the handler', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView({ mayChangeHandler: false }) });
    page();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /give back/i })).not.toBeInTheDocument();
  });

  it('says why a hand-over failed, and keeps the buttons', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView(), [`PUT ${HANDLER}`]: respond(403, { error: 'Not yours to change.', code: 'FORBIDDEN' }) });
    page();
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not yours to change.');
    expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled();
  });
});

describe('SellerConversationPage: Email from Sam', () => {
  it('is an admin\'s button; a record owner who is not an admin does not see it', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView({ mayEmail: false }) });
    page();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Email from Sam' })).not.toBeInTheDocument();
  });

  it('opens the composer for an admin', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView() });
    page(null, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Email from Sam' }));
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a practice copy to me' })).toBeInTheDocument();
  });

  it('is disabled, with the block in plain words, when Sam may not email', async () => {
    stubApi({ [`GET ${CONV}`]: sellerView({ mayEmail: false, emailBlock: 'suppressed' }) });
    page(null, { isAdmin: true });
    const button = await screen.findByRole('button', { name: 'Email from Sam' });
    expect(button).toBeDisabled();
    expect(screen.getByText('This address is on the do-not-email list')).toBeInTheDocument();
    expect(button).toHaveAccessibleDescription('This address is on the do-not-email list');
    expect(screen.queryByRole('button', { name: 'Write draft' })).not.toBeInTheDocument();
  });

  it('a seller block leaves the practice copy: the real button stays off with its words, and the practice copy drafts and sends with practice on', async () => {
    const calls = stubApi({
      [`GET ${CONV}`]: sellerView({ mayEmail: false, emailBlock: 'suppressed' }),
      [`POST ${CONV.replace('conversation', 'email/draft')}`]: { subject: 'About your house', body: 'Hi Jane', to: 'admin@gg.co' },
      [`POST ${CONV.replace('conversation', 'email/send')}`]: { emailId: rowId(5), sendAfter: new Date().toISOString(), to: 'admin@gg.co' },
    });
    page(null, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Email from Sam' })).toBeDisabled();
    expect(screen.getByText('This address is on the do-not-email list')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send a practice copy to me' }));
    // The composer now offers it (the page's own button gives way), and the real draft stays off.
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Send a practice copy to me' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send practice copy' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send practice copy' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { practice: true },
      { subject: 'About your house', body: 'Hi Jane', practice: true },
    ]);
  });

  it.each(['paused', 'disabled', 'not_configured'] as const)('%s (the switch or the server setup) offers no practice copy either', async (emailBlock) => {
    stubApi({ [`GET ${CONV}`]: sellerView({ mayEmail: false, emailBlock }) });
    page(null, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Email from Sam' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send a practice copy to me' })).not.toBeInTheDocument();
  });

  it('while the composer is open, a hand-over turns the real Send off with the block in words (the draft stays)', async () => {
    stubApi({
      [`GET ${CONV}`]: sellerView(),
      [`POST ${CONV.replace('conversation', 'email/draft')}`]: { subject: 'About your house', body: 'Hi Jane', to: 'jane@example.com' },
      [`PUT ${HANDLER}`]: sellerView({ handler: 'person', handlerName: 'Admin', mayEmail: false, emailBlock: 'taken_over' }),
    });
    page(null, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Email from Sam' }));
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(send).toBeDisabled());
    expect(send).toHaveAccessibleDescription('A person has taken over this seller');
    expect(screen.getByLabelText('Body')).toHaveValue('Hi Jane');
    expect(screen.getByRole('button', { name: 'Email from Sam' })).toBeDisabled();
  });

  it('a send refetches the conversation, so the queued email shows on the timeline', async () => {
    const queued = emailItem({ id: rowId(5), status: 'queued', at: '2026-10-20T16:00:00.000Z' });
    let reads = 0;
    const calls = stubApi({
      [`GET ${CONV}`]: sellerView(),
      [`POST ${CONV.replace('conversation', 'email/draft')}`]: { subject: 'About your house', body: 'Hi Jane', to: 'jane@example.com' },
      [`POST ${CONV.replace('conversation', 'email/send')}`]: { emailId: rowId(5), sendAfter: new Date().toISOString(), to: 'jane@example.com' },
    });
    // The second read answers with the queued email on the timeline.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/conversation') && (init?.method ?? 'GET') === 'GET') {
        reads += 1;
        if (reads > 1) return new Response(JSON.stringify(sellerView({ items: [callItem(), queued] })), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return real(input, init);
    }));
    page(null, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Email from Sam' }));
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByText('Waiting to send')).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1);
  });
});
