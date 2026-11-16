/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as texts from './texts';
import { TEXTS_BADGE_POLL_MS, useTextBadge } from './use-text-badge';

vi.mock('./texts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./texts')>();
  return { ...actual, fetchNewTextCount: vi.fn() };
});

const fetchNewTextCount = vi.mocked(texts.fetchNewTextCount);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchNewTextCount.mockReset().mockResolvedValue(0);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('useTextBadge', () => {
  it('asks for texts newer than the last one this rep saw, now and on a timer', async () => {
    texts.markTextsSeen('u1', '2026-11-16T17:00:00.000Z');
    fetchNewTextCount.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    const { result } = renderHook(() => useTextBadge({ userId: 'u1', active: true }));
    await flush();
    expect(fetchNewTextCount).toHaveBeenCalledWith('2026-11-16T17:00:00.000Z');
    expect(result.current).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS); });
    expect(result.current).toBe(3);
    expect(fetchNewTextCount).toHaveBeenCalledTimes(2);
  });

  it('shows nothing and asks nothing while inactive (the rep is on the Texts tab)', async () => {
    const { result } = renderHook(() => useTextBadge({ userId: 'u1', active: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS * 2); });
    expect(fetchNewTextCount).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it('clears and re-asks when the rep leaves the Texts tab', async () => {
    fetchNewTextCount.mockResolvedValueOnce(4);
    const { result, rerender } = renderHook(({ active }) => useTextBadge({ userId: 'u1', active }), { initialProps: { active: true } });
    await flush();
    expect(result.current).toBe(4);
    rerender({ active: false });
    expect(result.current).toBe(0);
    texts.markTextsSeen('u1', '2026-11-16T18:00:00.000Z');
    fetchNewTextCount.mockResolvedValueOnce(0);
    rerender({ active: true });
    await flush();
    expect(fetchNewTextCount).toHaveBeenLastCalledWith('2026-11-16T18:00:00.000Z');
    expect(result.current).toBe(0);
  });

  it('re-asks at once when another tab marks texts seen', async () => {
    fetchNewTextCount.mockResolvedValueOnce(4).mockResolvedValueOnce(0);
    const { result } = renderHook(() => useTextBadge({ userId: 'u1', active: true }));
    await flush();
    expect(result.current).toBe(4);
    localStorage.setItem(texts.textsSeenKey('u1'), '2026-11-16T18:00:00.000Z');
    window.dispatchEvent(new StorageEvent('storage', { key: texts.textsSeenKey('u1') }));
    await flush();
    expect(result.current).toBe(0);
    // Another rep's key on a shared machine is not ours to react to.
    window.dispatchEvent(new StorageEvent('storage', { key: texts.textsSeenKey('u2') }));
    await flush();
    expect(fetchNewTextCount).toHaveBeenCalledTimes(2);
  });

  it('keeps the last count through a failed check and tries again next time', async () => {
    fetchNewTextCount.mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(5);
    const { result } = renderHook(() => useTextBadge({ userId: 'u1', active: true }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS); });
    expect(result.current).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS); });
    expect(result.current).toBe(5);
  });

  it('skips the timed check while the page is hidden, and checks the moment it is shown', async () => {
    let hidden = false;
    const spy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    try {
      renderHook(() => useTextBadge({ userId: 'u1', active: true }));
      await flush();
      expect(fetchNewTextCount).toHaveBeenCalledTimes(1);
      hidden = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS * 3); });
      expect(fetchNewTextCount).toHaveBeenCalledTimes(1);
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(fetchNewTextCount).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('stops asking once unmounted', async () => {
    const { unmount } = renderHook(() => useTextBadge({ userId: 'u1', active: true }));
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(TEXTS_BADGE_POLL_MS * 3); });
    expect(fetchNewTextCount).toHaveBeenCalledTimes(1);
  });
});
