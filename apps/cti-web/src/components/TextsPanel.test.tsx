/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as texts from '../texts';
import * as opencti from '../opencti';
import { TextsPanel, TEXTS_PANEL_POLL_MS } from './TextsPanel';

vi.mock('../texts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../texts')>();
  return { ...actual, fetchTexts: vi.fn(), fetchNewTextCount: vi.fn() };
});

const fetchTexts = vi.mocked(texts.fetchTexts);
const fetchNewTextCount = vi.mocked(texts.fetchNewTextCount);

function textItem(over: Partial<texts.TextItem> = {}): texts.TextItem {
  return {
    id: 'm-1',
    fromE164: '+16195550100',
    toE164: '+16193507799',
    body: 'Call me after 3',
    numMedia: 0,
    receivedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    optOut: false,
    salesforce: 'logged',
    senderName: null,
    openRecordId: null,
    ...over,
  };
}

beforeEach(() => {
  fetchTexts.mockReset();
  fetchNewTextCount.mockReset().mockResolvedValue(0);
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TextsPanel', () => {
  it('lists each text with who sent it, when, and what it says', async () => {
    fetchTexts.mockResolvedValue([
      textItem({ id: 'a', senderName: 'Pat Seller', body: 'Is the offer still good?' }),
      textItem({ id: 'b', fromE164: '+18585550111', body: 'STOP', optOut: true }),
      textItem({ id: 'c', body: '', numMedia: 1, salesforce: 'reconnect' }),
    ]);
    render(<TextsPanel onSeen={() => {}} />);
    expect(await screen.findByText('Pat Seller')).toBeTruthy();
    expect(screen.getByText('Is the offer still good?')).toBeTruthy();
    expect(screen.getByText('+1 (858) 555-0111')).toBeTruthy();
    expect(screen.getByText('Asked to STOP')).toBeTruthy();
    expect(screen.getByText('1 attachment (not shown)')).toBeTruthy();
    expect(screen.getByText('Not in Salesforce · sign-in expired')).toBeTruthy();
    // The number still shows under a Salesforce name, so the rep can tell two Pats apart.
    expect(screen.getByText(/\+1 \(619\) 555-0100 · 2h ago/)).toBeTruthy();
  });

  it('opens the record in Salesforce when a text is tapped', async () => {
    fetchTexts.mockResolvedValue([textItem({ senderName: 'Pat Seller', openRecordId: '006000000000001AAA' })]);
    render(<TextsPanel onSeen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Pat Seller/ }));
    expect(opencti.screenPopRecord).toHaveBeenCalledWith('006000000000001AAA');
  });

  it('a text with nothing to open is not a button', async () => {
    fetchTexts.mockResolvedValue([textItem({ senderName: 'Pat Seller', openRecordId: null })]);
    render(<TextsPanel onSeen={() => {}} />);
    await screen.findByText('Pat Seller');
    expect(screen.queryByRole('button', { name: /Pat Seller/ })).toBeNull();
  });

  it('marks the newest text as seen once the list is on screen', async () => {
    const onSeen = vi.fn();
    fetchTexts.mockResolvedValue([
      textItem({ id: 'new', receivedAt: '2026-11-16T18:00:00.000Z' }),
      textItem({ id: 'old', receivedAt: '2026-11-16T17:00:00.000Z' }),
    ]);
    render(<TextsPanel onSeen={onSeen} />);
    await waitFor(() => expect(onSeen).toHaveBeenCalledWith('2026-11-16T18:00:00.000Z'));
  });

  it('says so plainly when there are no texts, and marks nothing seen', async () => {
    const onSeen = vi.fn();
    fetchTexts.mockResolvedValue([]);
    render(<TextsPanel onSeen={onSeen} />);
    expect(await screen.findByText('No texts yet')).toBeTruthy();
    expect(onSeen).not.toHaveBeenCalled();
  });

  it('offers a retry when the list cannot load', async () => {
    fetchTexts.mockRejectedValueOnce(new Error('API 500: {}')).mockResolvedValueOnce([textItem({ senderName: 'Pat Seller' })]);
    render(<TextsPanel onSeen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Pat Seller')).toBeTruthy();
  });

  it('while open, checks for new texts and reloads the list only when one arrived', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchTexts
      .mockResolvedValueOnce([textItem({ id: 'a', senderName: 'Pat Seller', receivedAt: '2026-11-16T18:00:00.000Z' })])
      .mockResolvedValueOnce([
        textItem({ id: 'b', senderName: 'Lee Lead', receivedAt: '2026-11-16T18:05:00.000Z' }),
        textItem({ id: 'a', senderName: 'Pat Seller', receivedAt: '2026-11-16T18:00:00.000Z' }),
      ]);
    render(<TextsPanel onSeen={() => {}} />);
    await screen.findByText('Pat Seller');
    expect(fetchTexts).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_PANEL_POLL_MS); });
    expect(fetchNewTextCount).toHaveBeenLastCalledWith('2026-11-16T18:00:00.000Z');
    expect(fetchTexts).toHaveBeenCalledTimes(1);

    fetchNewTextCount.mockResolvedValueOnce(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_PANEL_POLL_MS); });
    expect(await screen.findByText('Lee Lead')).toBeTruthy();
    expect(fetchTexts).toHaveBeenCalledTimes(2);
  });
});
