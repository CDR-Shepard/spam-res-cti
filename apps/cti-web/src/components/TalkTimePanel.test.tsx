/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TalkTimePanel } from './TalkTimePanel';
import * as talkApi from '../talk-time-api';
import { ApiError } from '../api';

vi.mock('../talk-time-api');

/** A promise this test controls the settling of, for asserting what the UI
 *  shows WHILE a request is still in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const REPORT: talkApi.TalkTimeReport = {
  from: '2026-10-01',
  to: '2026-10-01',
  timezone: 'America/Los_Angeles',
  reps: [
    {
      userId: 'u1',
      name: 'Garrett Martorello',
      talkSeconds: 3725,
      connectedCalls: 9,
      bySource: { outbound: { calls: 4, seconds: 1200 }, powerDial: { calls: 3, seconds: 1925 }, inbound: { calls: 2, seconds: 600 } },
      dialerSeconds: 7200,
      days: [{ day: '2026-10-01', talkSeconds: 3725, connectedCalls: 9, dialerSeconds: 7200 }],
    },
  ],
  totals: { talkSeconds: 3725, connectedCalls: 9, dialerSeconds: 7200 },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T18:00:00Z')); // Thu Oct 1, 11:00 PDT
  vi.mocked(talkApi.getTalkTime).mockResolvedValue(REPORT);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('TalkTimePanel', () => {
  it('loads today (Pacific): one row per rep, h:mm:ss, and a totals row', async () => {
    render(<TalkTimePanel />);
    expect(await screen.findByRole('button', { name: 'Garrett Martorello' })).toBeTruthy();
    expect(talkApi.getTalkTime).toHaveBeenCalledWith('2026-10-01', '2026-10-01');
    expect(screen.getAllByText('1:02:05')).toHaveLength(2); // the rep and the total
    expect(screen.getAllByText('0:32:05')).toHaveLength(2); // power-dial talk
    expect(screen.getAllByText('2:00:00')).toHaveLength(2); // time on the dialer
    expect(screen.getByText('Total')).toBeTruthy();
  });

  it('This week asks for Monday through today', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-09-28', '2026-10-01'));
  });

  it('Last 7 days asks for today and the six days before', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-09-25', '2026-10-01'));
  });

  it('a From after To pulls To along, so the range never reverses', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-03' } });
    await waitFor(() => expect(talkApi.getTalkTime).toHaveBeenLastCalledWith('2026-10-03', '2026-10-03'));
  });

  it('tapping a rep shows their per-day rows', async () => {
    render(<TalkTimePanel />);
    const rep = await screen.findByRole('button', { name: 'Garrett Martorello' });
    expect(screen.queryByText('Thu 10/1')).toBeNull();
    fireEvent.click(rep);
    expect(screen.getByText('Thu 10/1')).toBeTruthy();
    expect(rep.getAttribute('aria-expanded')).toBe('true');
  });

  it('a failed load says so', async () => {
    vi.mocked(talkApi.getTalkTime).mockRejectedValue(new Error('500'));
    render(<TalkTimePanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('Could not load talk time.');
  });

  it('a 400 shows the server\'s own message, not the generic one', async () => {
    vi.mocked(talkApi.getTalkTime).mockRejectedValue(new ApiError(400, { error: 'at most 92 days' }));
    render(<TalkTimePanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('at most 92 days');
  });

  it('a reload shows a loading state while the current table stays up', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });

    const next = deferred<talkApi.TalkTimeReport>();
    vi.mocked(talkApi.getTalkTime).mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));

    // Still showing last range's data, now with a visible loading indicator —
    // not silently stale, not blanked out either.
    await waitFor(() => expect(screen.getByText(/Loading/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Garrett Martorello' })).toBeTruthy();

    next.resolve({ ...REPORT, from: '2026-09-28' });
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
  });

  it('an error on reload clears the previous range\'s table — never stale rows under a new-range error', async () => {
    render(<TalkTimePanel />);
    await screen.findByRole('button', { name: 'Garrett Martorello' });

    vi.mocked(talkApi.getTalkTime).mockRejectedValueOnce(new Error('500'));
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Garrett Martorello' })).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();
  });

  it('an empty range says nobody talked', async () => {
    vi.mocked(talkApi.getTalkTime).mockResolvedValue({ ...REPORT, reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } });
    render(<TalkTimePanel />);
    expect(await screen.findByText('No talk time in this range.')).toBeTruthy();
    expect(screen.queryByText('Total')).toBeNull();
  });
});
