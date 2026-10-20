import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EmailBlock } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { SELLER_ID } from '../test/seller-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { PREVIEW_WORDS } from '../lib/seller-words';
import { SellerEmailComposer } from './seller-email-composer';

afterEach(() => vi.unstubAllGlobals());

const BASE = `/api/sellers/${SELLER_ID}`;
const DRAFT = `POST ${BASE}/email/draft`;
const SEND = `POST ${BASE}/email/send`;
const draftBody = { subject: 'About your house', body: 'Hi Jane,\nI am Sam, an AI assistant.', to: 'jane@example.com' };
const sent = (to: string, sendAfter: string) => ({ emailId: '00000000-0000-4000-8000-0000000000aa', sendAfter, to });
/** Far enough ahead that it is never "now" and never today. */
const LATER = new Date(Date.now() + 3 * 24 * 3600 * 1000);

const open = (emailBlock: EmailBlock | null = null) =>
  renderWithProviders(<SellerEmailComposer sfRecordId={SELLER_ID} emailBlock={emailBlock} onClose={() => {}} />, { isAdmin: true });

/** The composer with a button that turns the seller's block on while it is open (a Take over, the daily cap). */
function Flippable({ then }: { then: EmailBlock }) {
  const [block, setBlock] = useState<EmailBlock | null>(null);
  return (
    <>
      <button type="button" onClick={() => setBlock(then)}>flip</button>
      <SellerEmailComposer sfRecordId={SELLER_ID} emailBlock={block} onClose={() => {}} />
    </>
  );
}

describe('SellerEmailComposer: a real email', () => {
  it('Write draft asks Sam (practice off) and shows editable Subject and Body, the To address and the footer note', async () => {
    const calls = stubApi({ [DRAFT]: draftBody });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    const subject = await screen.findByLabelText('Subject');
    expect(subject).toHaveValue('About your house');
    expect(screen.getByLabelText('Body')).toHaveValue('Hi Jane,\nI am Sam, an AI assistant.');
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('The footer with the unsubscribe link is added automatically.')).toBeInTheDocument();
    expect(calls).toEqual([{ url: `${BASE}/email/draft`, method: 'POST', body: { practice: false } }]);
  });

  it('Send goes through a confirm step, then sends the EDITED text', async () => {
    const calls = stubApi({ [DRAFT]: draftBody, [SEND]: sent('jane@example.com', LATER.toISOString()) });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    const body = await screen.findByLabelText('Body');
    await userEvent.clear(body);
    await userEvent.type(body, 'Hi Jane, can we talk?');
    await userEvent.clear(screen.getByLabelText('Subject'));
    await userEvent.type(screen.getByLabelText('Subject'), 'Quick question');

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Send this email to jane@example.com?')).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith('/send'))).toEqual({
      url: `${BASE}/email/send`, method: 'POST', body: { subject: 'Quick question', body: 'Hi Jane, can we talk?', practice: false },
    });
  });

  it('after the send it says when the email goes out, and clears the draft', async () => {
    stubApi({ [DRAFT]: draftBody, [SEND]: sent('jane@example.com', LATER.toISOString()) });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Queued for jane@example.com. It goes out ');
    expect(status).not.toHaveTextContent(/null|undefined|Invalid/);
    expect(screen.queryByLabelText('Body')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeInTheDocument();
  });

  it('says "now" when the email is due right away', async () => {
    stubApi({ [DRAFT]: draftBody, [SEND]: sent('jane@example.com', new Date().toISOString()) });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('status')).toHaveTextContent('It goes out now.');
  });

  it('Cancel in the confirm step sends nothing', async () => {
    const calls = stubApi({ [DRAFT]: draftBody });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((c) => c.url.endsWith('/send'))).toHaveLength(0);
    expect(screen.getByLabelText('Body')).toBeInTheDocument();
  });

  it('Discard throws the draft away and goes back to the start', async () => {
    stubApi({ [DRAFT]: draftBody });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.queryByLabelText('Body')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeInTheDocument();
  });

  it('will not send a draft with an empty subject or body, or one past the limits', async () => {
    stubApi({ [DRAFT]: draftBody });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    const subject = await screen.findByLabelText('Subject');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await userEvent.clear(subject);
    expect(send).toBeDisabled();
    fireEvent.change(subject, { target: { value: 'x'.repeat(151) } });
    expect(send).toBeDisabled();
    fireEvent.change(subject, { target: { value: 'Fine' } });
    expect(send).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '   ' } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'y'.repeat(3001) } });
    expect(send).toBeDisabled();
  });
});

describe('SellerEmailComposer: a practice copy', () => {
  it('"Send a practice copy to me" drafts with practice on, and the confirm says it goes to you, right away', async () => {
    const calls = stubApi({
      [DRAFT]: { ...draftBody, to: 'admin@gg.co' },
      [SEND]: sent('admin@gg.co', new Date().toISOString()),
    });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Send a practice copy to me' }));
    expect(await screen.findByLabelText('Subject')).toHaveValue('About your house');
    expect(calls[0]).toEqual({ url: `${BASE}/email/draft`, method: 'POST', body: { practice: true } });
    expect(screen.getByText('admin@gg.co')).toBeInTheDocument();
    expect(screen.getByText('Practice copy: it goes to your own address, not to the seller.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Send practice copy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Send a practice copy to admin@gg.co?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('right away');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send practice copy' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/send'))?.body).toEqual({ subject: 'About your house', body: 'Hi Jane,\nI am Sam, an AI assistant.', practice: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Practice copy queued for admin@gg.co. It goes out now.');
  });
});

describe('SellerEmailComposer: sending only once, and what goes wrong', () => {
  it('the Send button is off while a send is in flight, so a second click cannot send twice', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const sends: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/email/draft')) return new Response(JSON.stringify(draftBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
      sends.push(init?.body);
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return new Response(JSON.stringify(sent('jane@example.com', LATER.toISOString())), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(sends).toHaveLength(1);
    gate.release?.();
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(sends).toHaveLength(1);
  });

  it('409 EMAIL_ALREADY_QUEUED says an email is already waiting, and keeps the draft', async () => {
    stubApi({ [DRAFT]: draftBody, [SEND]: respond(409, { error: 'server words', code: 'EMAIL_ALREADY_QUEUED' }) });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An email to this seller is already waiting to go out.');
    expect(screen.getByLabelText('Body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('a refused send lists what is wrong with the draft', async () => {
    stubApi({
      [DRAFT]: draftBody,
      [SEND]: respond(422, { error: 'Fix the draft before it is sent.', code: 'DRAFT_INVALID', details: ['The body has a link.', 'The subject is shouting.'] }),
    });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Fix the draft before it is sent.');
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['The body has a link.', 'The subject is shouting.']);
  });

  it.each([
    [respond(429, { error: 'x', code: 'AI_BUDGET' }), "Sam's AI budget for today is used up"],
    [respond(502, { error: 'x', code: 'MODEL_ERROR' }), 'Sam could not write a draft right now. Try again.'],
    [respond(422, { error: 'x', code: 'DRAFT_REFUSED' }), 'Sam would not write this email'],
    [respond(409, { error: 'x', code: 'not_approved' }), 'No approved call plan yet'],
  ])('a draft that fails says why in plain words: %#', async (failure, words) => {
    stubApi({ [DRAFT]: failure });
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(screen.queryByLabelText('Body')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeEnabled();
  });

  it('shows that Sam is writing while the draft is on its way, with both start buttons off', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return new Response(JSON.stringify(draftBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sam is writing a draft');
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a practice copy to me' })).toBeDisabled();
    gate.release?.();
    expect(await screen.findByLabelText('Body')).toBeInTheDocument();
  });
});

describe('SellerEmailComposer: when Sam may not email', () => {
  const PRACTICE = 'Send a practice copy to me';

  it('a seller block (suppressed) turns the real draft off with its words, and leaves the practice copy: drafted and sent with practice on', async () => {
    const calls = stubApi({ [DRAFT]: { ...draftBody, to: 'admin@gg.co' }, [SEND]: sent('admin@gg.co', new Date().toISOString()) });
    open('suppressed');
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeDisabled();
    expect(screen.getByText('This address is on the do-not-email list')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PRACTICE })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: PRACTICE }));
    expect(await screen.findByLabelText('Subject')).toHaveValue('About your house');
    expect(calls[0]).toEqual({ url: `${BASE}/email/draft`, method: 'POST', body: { practice: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Send practice copy' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Send practice copy' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/send'))?.body).toMatchObject({ practice: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Practice copy queued for admin@gg.co.');
  });

  it('not_configured (the server setup) turns off both, with the words shown once', () => {
    open('not_configured');
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: PRACTICE })).toBeDisabled();
    expect(screen.getAllByText('Email is not set up on this server yet')).toHaveLength(1);
    expect(screen.queryByText(PREVIEW_WORDS)).not.toBeInTheDocument();
  });

  it.each([
    ['disabled', 'Email from Sam is turned off'],
    ['paused', 'Email from Sam is paused after a spam complaint'],
  ] as const)('%s (the switch): Write draft still shows what Sam would send, and its Send stays off (owner, 2026-10-20)', async (block, words) => {
    const calls = stubApi({ [DRAFT]: draftBody });
    open(block);
    expect(screen.getByRole('button', { name: PRACTICE })).toBeDisabled();
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_WORDS)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    expect(await screen.findByLabelText('Body')).toHaveValue(draftBody.body);
    expect(calls[0]).toEqual({ url: `${BASE}/email/draft`, method: 'POST', body: { practice: false } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAccessibleDescription(words);
  });

  it('a block that turns up while a real draft is open turns its Send off with the words; Discard then leaves only the practice copy', async () => {
    stubApi({ [DRAFT]: draftBody });
    renderWithProviders(<Flippable then="taken_over" />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: 'Write draft' }));
    await screen.findByLabelText('Body');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription('A person has taken over this seller');
    // The edited text is kept: nothing is lost while the seller is blocked.
    expect(screen.getByLabelText('Body')).toHaveValue('Hi Jane,\nI am Sam, an AI assistant.');
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(screen.getByRole('button', { name: 'Write draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: PRACTICE })).toBeEnabled();
  });

  it('an open practice draft keeps its Send through a seller block, and loses it to a setup block', async () => {
    stubApi({ [DRAFT]: { ...draftBody, to: 'admin@gg.co' } });
    const { unmount } = renderWithProviders(<Flippable then="daily_cap" />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: PRACTICE }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByRole('button', { name: 'Send practice copy' })).toBeEnabled();
    unmount();

    renderWithProviders(<Flippable then="paused" />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: PRACTICE }));
    await screen.findByLabelText('Body');
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByRole('button', { name: 'Send practice copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send practice copy' })).toHaveAccessibleDescription('Email from Sam is paused after a spam complaint');
  });
});
