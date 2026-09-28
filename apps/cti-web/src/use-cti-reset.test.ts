/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { pageReloader } from './cti-reset';
import { RESET_IDLE_CHECK_MS } from './reset-poller';
import type { SoftphoneCoordinator } from './softphone-coordinator';
import { fetchResetDue, postResetComplete, RESET_COMPLETE_TIMEOUT_MS, useCtiReset } from './use-cti-reset';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@x.com' }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('fetchResetDue', () => {
  it('GETs /auth/reset-signal with the session token, and is true only for resetDue === true', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ resetDue: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchResetDue()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/auth\/reset-signal$/);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    for (const body of [{ resetDue: false }, {}, { resetDue: 'true' }, null]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      await expect(fetchResetDue()).resolves.toBe(false);
    }
  });

  it('rejects on a 401, which the poller ignores (never a sign-out)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401)));
    await expect(fetchResetDue()).rejects.toMatchObject({ status: 401 });
  });
});

describe('postResetComplete', () => {
  it('POSTs /auth/reset-complete with the session token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await postResetComplete();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/auth\/reset-complete$/);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('gives up after 5 s, so a hung network cannot leave the rep without a Device for long', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const done = expect(postResetComplete()).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(RESET_COMPLETE_TIMEOUT_MS);
    await done;
  });
});

// ---------------------------------------------------------------------------
// The hook itself, driven by a fake coordinator (no BroadcastChannel, no App).
// ---------------------------------------------------------------------------

interface FakeCoord { leader: boolean; settled: boolean; peersBusy: boolean; broadcasts: number; coord: SoftphoneCoordinator }

function fakeCoordinator(): FakeCoord {
  const f: FakeCoord = {
    leader: true, settled: true, peersBusy: false, broadcasts: 0,
    coord: {
      start: () => {}, stop: () => {}, onLeadershipChange: () => {}, onStateChange: () => {}, promoteSelf: () => {},
      isLeader: () => f.leader,
      settled: () => f.settled,
      peersBusyForReset: () => f.peersBusy,
      broadcastReset: () => { f.broadcasts += 1; },
      onReset: () => {},
    },
  };
  return f;
}

/** Mount useCtiReset over a fake coordinator. The reset-signal answers
 *  `s.due`; with `holdPost`, POST reset-complete waits for `release()`. */
function mountHook(opts: { due?: boolean; holdPost?: boolean } = {}) {
  const events: string[] = [];
  const f = fakeCoordinator();
  const s = { busy: false, due: opts.due ?? true };
  let releasePost: () => void = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/auth/reset-signal')) return jsonResponse({ resetDue: s.due });
    if (url.includes('/auth/reset-complete') && init?.method === 'POST') {
      events.push('post');
      if (opts.holdPost) await new Promise<void>((r) => { releasePost = r; });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({});
  }));
  vi.spyOn(pageReloader, 'reload').mockImplementation(() => { events.push('reload'); });
  const coordinatorRef = { current: f.coord as SoftphoneCoordinator | null };
  const hook = renderHook(() => useCtiReset({
    enabled: true,
    coordinatorRef,
    isBusy: () => s.busy,
    teardownDevice: () => { events.push('teardown'); },
    setResetting: (on) => { events.push(on ? 'latch' : 'unlatch'); },
  }));
  return { events, f, s, hook, release: () => releasePost() };
}

async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useCtiReset — the leader resets an idle tab', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('latch → teardown → POST → broadcast → reload, the latch strictly before the Device goes', async () => {
    vi.useFakeTimers();
    const h = mountHook();
    await tick(RESET_IDLE_CHECK_MS * 2);
    expect(h.events).toEqual(['latch', 'teardown', 'post', 'reload']);
    expect(h.f.broadcasts).toBe(1);
  });

  // C1(d): something became live in this tab while the POST was in flight.
  it('busy again when the POST comes back: no broadcast, wipe or reload until idle', async () => {
    vi.useFakeTimers();
    const h = mountHook({ holdPost: true });
    await tick(RESET_IDLE_CHECK_MS * 2);
    expect(h.events).toEqual(['latch', 'teardown', 'post']);
    h.s.busy = true;
    h.release();
    await tick(RESET_IDLE_CHECK_MS * 3);
    expect(h.events).toEqual(['latch', 'teardown', 'post']);
    expect(h.f.broadcasts).toBe(0);
    expect(localStorage.getItem('cti.session.v1')).not.toBeNull();
    h.s.busy = false;
    await tick(RESET_IDLE_CHECK_MS);
    expect(h.events).toEqual(['latch', 'teardown', 'post', 'reload']);
    expect(h.f.broadcasts).toBe(1);
    expect(localStorage.getItem('cti.session.v1')).toBeNull();
  });
});
