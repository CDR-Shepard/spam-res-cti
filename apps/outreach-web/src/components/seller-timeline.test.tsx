import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimelineItem } from '@cti/contracts';
import { durationWords } from '@/lib/seller-words';
import { formatDateTime } from '@/lib/outreach-words';
import { renderWithProviders } from '../test/render';
import { callItem, emailItem, noteItem, rowId } from '../test/seller-fixtures';
import { stubApi } from '../test/stub-api';
import { HIGHLIGHT_MS, SellerTimeline } from './seller-timeline';

const scrollSpy = vi.fn();

beforeEach(() => {
  scrollSpy.mockClear();
  // jsdom has no scrollIntoView; the timeline calls it when it exists.
  Element.prototype.scrollIntoView = scrollSpy;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // @ts-expect-error jsdom does not define it: put it back the way it was.
  delete Element.prototype.scrollIntoView;
});

const rowEl = (item: TimelineItem): HTMLElement => document.getElementById(`event-${item.id}`) as HTMLElement;
const scrolledTo = (): string[] => scrollSpy.mock.contexts.map((el) => (el as HTMLElement).id);

const CALL = callItem({ id: rowId(1) });
const EMAIL_IN = emailItem({ id: rowId(2), direction: 'in', actor: 'seller', subject: 'Re: About your house', body: 'Not interested.\nPlease stop.', status: 'received', at: '2026-10-19T18:00:00.000Z' });
const NOTE = noteItem({ id: rowId(3), at: '2026-10-19T19:00:00.000Z' });

describe('SellerTimeline rows', () => {
  it('lists every row oldest first, each carrying id="event-<id>"', () => {
    renderWithProviders(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={null} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.id)).toEqual([`event-${CALL.id}`, `event-${EMAIL_IN.id}`, `event-${NOTE.id}`]);
    expect(within(rows[0]!).getByText('Callback booked')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Re: About your house')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/Taken over by Dana/)).toBeInTheDocument();
  });

  it('a call row shows the outcome, the length and the summary, and the time', () => {
    renderWithProviders(<SellerTimeline items={[CALL]} focusEventId={null} />);
    const row = within(rowEl(CALL));
    expect(row.getByText('AI call')).toBeInTheDocument();
    expect(row.getByText('Callback booked')).toBeInTheDocument();
    expect(row.getByText(durationWords(192))).toBeInTheDocument();
    expect(row.getByText('Wants a call back Thursday evening.')).toBeInTheDocument();
    expect(row.getByText(formatDateTime(CALL.at))).toBeInTheDocument();
  });

  it('a call with no outcome, summary or length renders none of them (no "null", no "0:00")', () => {
    const bare = callItem({ id: rowId(5), outcome: null, summary: null, durationSeconds: null });
    renderWithProviders(<SellerTimeline items={[bare]} focusEventId={null} />);
    const row = rowEl(bare);
    expect(within(row).getByText('AI call')).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/null|0:00|undefined/);
    expect(row.querySelector('p.whitespace-pre-wrap')).toBeNull();
  });

  it('offers the transcript only when there is one, and opens the existing panel', async () => {
    const withTranscript = callItem({ id: rowId(6), transcriptAvailable: true });
    const calls = stubApi({
      [`GET /api/ai-calls/${withTranscript.id}/transcript`]: { aiCallId: withTranscript.id, lines: [{ role: 'agent', text: 'Hi, this is an AI assistant.', at: null }], turnStats: null },
    });
    renderWithProviders(<SellerTimeline items={[CALL, withTranscript]} focusEventId={null} />);
    expect(within(rowEl(CALL)).queryByRole('button', { name: /transcript/i })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await userEvent.click(within(rowEl(withTranscript)).getByRole('button', { name: 'Transcript' }));
    expect(await screen.findByText('Hi, this is an AI assistant.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.queryByText('Hi, this is an AI assistant.')).not.toBeInTheDocument();
  });

  it('an email row shows who sent it, the subject, the body as written (line breaks kept) and where it stands', () => {
    const out = emailItem({ id: rowId(7), status: 'delivered' });
    renderWithProviders(<SellerTimeline items={[out, EMAIL_IN]} focusEventId={null} />);
    const sent = within(rowEl(out));
    expect(sent.getByText('Email from Sam')).toBeInTheDocument();
    expect(sent.getByText('About your house')).toBeInTheDocument();
    expect(sent.getByText('Delivered')).toBeInTheDocument();
    const body = rowEl(out).querySelector('p.whitespace-pre-wrap');
    expect(body?.textContent).toBe('Hi Jane,\nI am Sam, an AI assistant.');
    const received = within(rowEl(EMAIL_IN));
    expect(received.getByText('Email from the seller')).toBeInTheDocument();
    expect(received.getByText('Received')).toBeInTheDocument();
  });

  it('says a person wrote an email they sent', () => {
    const byPerson = emailItem({ id: rowId(8), actor: 'person' });
    renderWithProviders(<SellerTimeline items={[byPerson]} focusEventId={null} />);
    expect(within(rowEl(byPerson)).getByText('Email from a person')).toBeInTheDocument();
  });

  it('a canceled email says "Not sent" and why, in plain words', () => {
    const canceled = emailItem({ id: rowId(9), status: 'canceled', notSentReason: 'suppressed' });
    const unexplained = emailItem({ id: rowId(10), status: 'canceled', notSentReason: null });
    renderWithProviders(<SellerTimeline items={[canceled, unexplained]} focusEventId={null} />);
    expect(within(rowEl(canceled)).getByText('Not sent: This address is on the do-not-email list')).toBeInTheDocument();
    expect(within(rowEl(unexplained)).getByText('Not sent')).toBeInTheDocument();
  });

  it('tags an auto-reply', () => {
    const auto = emailItem({ id: rowId(11), direction: 'in', actor: 'seller', status: 'received', autoReply: true });
    renderWithProviders(<SellerTimeline items={[auto, EMAIL_IN]} focusEventId={null} />);
    expect(within(rowEl(auto)).getByText('Auto-reply')).toBeInTheDocument();
    expect(within(rowEl(EMAIL_IN)).queryByText('Auto-reply')).not.toBeInTheDocument();
  });

  it('shows seller text as text only: markup in a subject or body is never turned into elements', () => {
    const hostile = emailItem({
      id: rowId(12), direction: 'in', actor: 'seller', status: 'received',
      subject: '<b>bold</b> subject', body: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
    });
    const call = callItem({ id: rowId(13), summary: '<i>italic</i> summary' });
    renderWithProviders(<SellerTimeline items={[hostile, call]} focusEventId={null} />);
    expect(screen.getByText('<b>bold</b> subject')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror="alert(1)"><script>alert(2)</script>')).toBeInTheDocument();
    expect(screen.getByText('<i>italic</i> summary')).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(list.querySelector('img, script, b, i')).toBeNull();
  });

  it('a note row is one muted line', () => {
    renderWithProviders(<SellerTimeline items={[NOTE]} focusEventId={null} />);
    const row = rowEl(NOTE);
    const line = within(row).getByText(/Taken over by Dana/);
    expect(line).toHaveClass('text-muted-foreground');
    expect(row.querySelectorAll('p')).toHaveLength(1);
    expect(line).toHaveTextContent(formatDateTime(NOTE.at));
  });

  it('says so when nothing has happened yet', () => {
    renderWithProviders(<SellerTimeline items={[]} focusEventId={null} />);
    expect(screen.getByText('Nothing has happened with this seller yet.')).toBeInTheDocument();
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('SellerTimeline scrolling', () => {
  it('opens at the newest row', () => {
    render(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={null} />);
    expect(scrolledTo()).toEqual([`event-${NOTE.id}`]);
  });

  it('scrolls again when a newer row arrives, but not when the same rows are read again', () => {
    const { rerender } = render(<SellerTimeline items={[CALL, EMAIL_IN]} focusEventId={null} />);
    expect(scrolledTo()).toEqual([`event-${EMAIL_IN.id}`]);
    rerender(<SellerTimeline items={[CALL, EMAIL_IN]} focusEventId={null} />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    rerender(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={null} />);
    expect(scrolledTo()).toEqual([`event-${EMAIL_IN.id}`, `event-${NOTE.id}`]);
  });

  it('a #event-<id> link scrolls that row into view instead of the newest, and highlights it for a moment', () => {
    vi.useFakeTimers();
    render(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={EMAIL_IN.id} />);
    expect(scrolledTo()).toEqual([`event-${EMAIL_IN.id}`]);
    expect(rowEl(EMAIL_IN)).toHaveAttribute('data-highlighted', 'true');
    expect(rowEl(CALL)).not.toHaveAttribute('data-highlighted');
    expect(rowEl(NOTE)).not.toHaveAttribute('data-highlighted');
    act(() => { vi.advanceTimersByTime(HIGHLIGHT_MS - 1); });
    expect(rowEl(EMAIL_IN)).toHaveAttribute('data-highlighted', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(rowEl(EMAIL_IN)).not.toHaveAttribute('data-highlighted');
  });

  it('under StrictMode (which runs every effect twice) the mark still goes away, and the row is scrolled to once', () => {
    vi.useFakeTimers();
    render(<StrictMode><SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={EMAIL_IN.id} /></StrictMode>);
    expect(rowEl(EMAIL_IN)).toHaveAttribute('data-highlighted', 'true');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(HIGHLIGHT_MS); });
    expect(rowEl(EMAIL_IN)).not.toHaveAttribute('data-highlighted');
  });

  it('a link to a row that is not there opens at the newest, with nothing highlighted', () => {
    render(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={rowId(99)} />);
    expect(scrolledTo()).toEqual([`event-${NOTE.id}`]);
    for (const item of [CALL, EMAIL_IN, NOTE]) expect(rowEl(item)).not.toHaveAttribute('data-highlighted');
  });

  it('finds a linked row that only arrives with the refetch', () => {
    const { rerender } = render(<SellerTimeline items={[CALL, EMAIL_IN]} focusEventId={NOTE.id} />);
    expect(scrolledTo()).toEqual([`event-${EMAIL_IN.id}`]);
    rerender(<SellerTimeline items={[CALL, EMAIL_IN, NOTE]} focusEventId={NOTE.id} />);
    expect(scrolledTo()).toEqual([`event-${EMAIL_IN.id}`, `event-${NOTE.id}`]);
    expect(rowEl(NOTE)).toHaveAttribute('data-highlighted', 'true');
  });
});
