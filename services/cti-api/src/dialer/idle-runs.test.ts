import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopIdleSession } from './engine.js';
import { DIALER_IDLE_MS } from './idle.js';
import { buildEngineDeps } from './live-deps.js';
import { MAX_CONVERSATION_MS } from '../reports/talk-time.js';
import {
  IDLE_CHECK_INTERVAL_MS,
  idleRunCandidatesStatement,
  isIdleRun,
  liveIdleRunDeps,
  maybeStartIdleRunLoop,
  startIdleRunLoop,
  stopIdleRunsTick,
  toCandidate,
  type IdleCandidate,
  type IdleRunDeps,
} from './idle-runs.js';

// engine.ts and live-deps.ts are OTHER modules, so mocking them is safe (unlike
// the module under test). Factories keep both from loading Twilio / the db.
vi.mock('./engine.js', () => ({ stopIdleSession: vi.fn() }));
vi.mock('./live-deps.js', () => ({ buildEngineDeps: vi.fn() }));

const NOW = new Date('2026-10-05T21:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const run = (sessionId: string, over: Partial<IdleCandidate> = {}): IdleCandidate => ({
  sessionId,
  userId: `u-${sessionId}`,
  lastActivityAt: ago(DIALER_IDLE_MS),
  live: false,
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('isIdleRun', () => {
  it('no live dial and the last activity exactly 15 minutes ago is idle', () => {
    expect(isIdleRun({ live: false, lastActivityAt: ago(15 * MIN) }, NOW)).toBe(true);
  });
  it('14:59 ago is not yet idle', () => {
    expect(isIdleRun({ live: false, lastActivityAt: ago(15 * MIN - 1000) }, NOW)).toBe(false);
  });
  it('a ringing dial or a live conversation is never cut, however long it has run', () => {
    expect(isIdleRun({ live: true, lastActivityAt: ago(3 * 60 * MIN) }, NOW)).toBe(false);
  });
  it('an unreadable last-activity time is never idle (the safe direction: do not hang up)', () => {
    expect(isIdleRun({ live: false, lastActivityAt: new Date('not a date') }, NOW)).toBe(false);
  });
});

describe('idleRunCandidatesStatement — the one query a tick runs', () => {
  const query = new PgDialect().sqlToQuery(idleRunCandidatesStatement(NOW));
  const text = query.sql.replace(/\s+/g, ' ').trim();
  const liveFloor = new Date(NOW.getTime() - MAX_CONVERSATION_MS).toISOString();

  it('selects the run and rep under the aliases toCandidate reads: session_id and user_id', () => {
    expect(text).toContain('select s.id as session_id, s.user_id,');
  });
  it('looks only at runs with an open rep leg: a run parked for a callback has dropped its leg', () => {
    expect(text).toContain('join dialer_rep_legs l on l.session_id = s.id and l.ended_at is null');
  });
  it('left-joins the items, so a run that never queued one is still a candidate', () => {
    expect(text).toContain('left join dialer_queue_items i on i.session_id = s.id');
  });
  it('is limited to active and paused runs', () => {
    expect(text).toContain("where s.status in ('active', 'paused')");
  });
  it('the last activity is the newest of the run, a leg join and an item change', () => {
    expect(text).toContain('greatest(s.updated_at, max(l.joined_at), max(i.updated_at)) as last_activity_at');
  });
  it("live = a dialing item, or connected with the prospect still on the line, touched within the 4-hour call limit; null-safe", () => {
    // Twilio ends any call at 4 hours, so an item still 'ringing' or 'talking'
    // after that is a lost callback, not a live call: it must not block the cut forever.
    expect(text).toContain(
      "coalesce(bool_or((i.status = 'dialing' or (i.status = 'connected' and i.prospect_ended_at is null)) and i.updated_at > $1::timestamptz), false) as live",
    );
  });
  it('binds the live floor — now minus MAX_CONVERSATION_MS (4 h) — as the one parameter, and nothing else', () => {
    expect(MAX_CONVERSATION_MS).toBe(4 * 3_600_000);
    expect(query.params).toEqual([liveFloor]);
  });
  it('groups by the run', () => {
    expect(text).toContain('group by s.id, s.user_id, s.updated_at');
  });
  it('unfiltered, it carries no session predicate: the tick looks at every candidate', () => {
    expect(text).not.toContain('s.id = $');
  });
  it('given a session id it adds `and s.id = $n` and carries the id as a bound parameter (the re-check)', () => {
    const filtered = new PgDialect().sqlToQuery(idleRunCandidatesStatement(NOW, 'sess-42'));
    const filteredText = filtered.sql.replace(/\s+/g, ' ').trim();
    expect(filteredText).toContain("where s.status in ('active', 'paused') and s.id = $2 group by");
    expect(filteredText).toContain('and s.id = $');
    expect(filtered.params).toEqual([liveFloor, 'sess-42']);
  });
});

describe('toCandidate — a raw db.execute row', () => {
  const base = { session_id: 's1', user_id: 'u1' };
  it('reads a Date or an ISO string for last_activity_at (raw execute may not parse timestamptz)', () => {
    const at = new Date('2026-10-05T19:00:00.000Z');
    expect(toCandidate({ ...base, last_activity_at: at, live: false }).lastActivityAt).toEqual(at);
    expect(toCandidate({ ...base, last_activity_at: '2026-10-05T19:00:00.000Z', live: false }).lastActivityAt).toEqual(at);
    expect(toCandidate({ ...base, last_activity_at: '2026-10-05 19:00:00+00', live: false }).lastActivityAt).toEqual(at);
  });
  it('reads live as a boolean or the strings t / true (and f / false)', () => {
    const live = (v: unknown) => toCandidate({ ...base, last_activity_at: NOW, live: v }).live;
    expect([true, 't', 'true'].map(live)).toEqual([true, true, true]);
    expect([false, 'f', 'false'].map(live)).toEqual([false, false, false]);
  });
  it('a live value it does not recognise counts as live: an unclear row is never cut', () => {
    expect(toCandidate({ ...base, last_activity_at: NOW, live: 'maybe' }).live).toBe(true);
    expect(toCandidate({ ...base, last_activity_at: NOW, live: null }).live).toBe(true);
  });
  it('maps the ids', () => {
    expect(toCandidate({ ...base, last_activity_at: NOW, live: false })).toMatchObject({ sessionId: 's1', userId: 'u1' });
  });
});

function deps(candidates: IdleCandidate[], stop: IdleRunDeps['stop'] = async () => ({ action: 'stopped' })): IdleRunDeps {
  // Like the real statement: given a session id, only that run (if it is still a candidate).
  return { candidates: async (id) => (id ? candidates.filter((c) => c.sessionId === id) : candidates), now: () => NOW, stop };
}

describe('stopIdleRunsTick', () => {
  it('stops exactly the idle runs, by id, and skips live and recent ones', async () => {
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const n = await stopIdleRunsTick(
      deps(
        [
          run('idle-a'),
          run('live', { lastActivityAt: ago(3 * 60 * MIN), live: true }),
          run('recent', { lastActivityAt: ago(14 * MIN) }),
          run('idle-b', { lastActivityAt: ago(7.5 * 60 * MIN) }),
        ],
        stop,
      ),
    );
    expect(stop.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['idle-a', 'idle-b']);
    expect(n).toBe(2);
  });

  it('logs ids and the idle minutes, and nothing else', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await stopIdleRunsTick(deps([run('s9', { userId: 'u9', lastActivityAt: ago(37 * MIN + 30_000) })]));
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[dialer] idle run stopped', { sessionId: 's9', userId: 'u9', idleMinutes: 37 });
  });

  it('one stop that fails is logged and the next idle run is still stopped', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('twilio 500');
      return { action: 'stopped' as const };
    });
    const n = await stopIdleRunsTick(deps([run('bad'), run('good')], stop));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(n).toBe(1);
    expect(error).toHaveBeenCalledWith('[dialer] idle run stop failed', { sessionId: 'bad', err: 'twilio 500' });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[dialer] idle run stopped', expect.objectContaining({ sessionId: 'good' }));
  });

  it('a run that had already ended (skipped) is neither logged as stopped nor counted', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stop = vi.fn(async (id: string) => ({ action: id === 'gone' ? ('skipped' as const) : ('stopped' as const) }));
    const n = await stopIdleRunsTick(deps([run('gone'), run('real')], stop));
    expect(stop).toHaveBeenCalledTimes(2);
    expect(n).toBe(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('[dialer] idle run stopped', expect.objectContaining({ sessionId: 'real' }));
  });

  it('re-checks each idle candidate by id right before stopping it, after one unfiltered snapshot', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const all = [run('idle-a'), run('recent', { lastActivityAt: ago(MIN) }), run('idle-b')];
    const candidates = vi.fn(async (id?: string) => (id ? all.filter((c) => c.sessionId === id) : all));
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    await stopIdleRunsTick({ candidates, now: () => NOW, stop });
    // snapshot (no id), then one re-check per idle candidate; the recent run is never re-checked.
    expect(candidates.mock.calls.map((c) => c[0])).toEqual([undefined, 'idle-a', 'idle-b']);
  });

  it('a candidate idle in the snapshot but live on the re-check is not stopped', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const candidates = async (id?: string) =>
      id === 'woke' ? [run('woke', { live: true })] : id === 'still' ? [run('still')] : [run('woke'), run('still')];
    const n = await stopIdleRunsTick({ candidates, now: () => NOW, stop });
    expect(stop.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['still']);
    expect(n).toBe(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('a candidate that got newer activity on the re-check (no longer 15 minutes old) is not stopped', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const candidates = async (id?: string) => (id ? [run('busy', { lastActivityAt: ago(MIN) })] : [run('busy')]);
    expect(await stopIdleRunsTick({ candidates, now: () => NOW, stop })).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('a candidate that vanished on the re-check (leg closed, run no longer active) is not stopped, silently', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const candidates = async (id?: string) => (id ? [] : [run('gone')]);
    expect(await stopIdleRunsTick({ candidates, now: () => NOW, stop })).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a candidate still idle on the re-check is stopped, judged at the re-check time', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const clock = [NOW, new Date(NOW.getTime() + 60_000)];
    const now = vi.fn(() => clock.shift() ?? NOW);
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const candidates = async (id?: string) => [run('idle-a', { lastActivityAt: ago(20 * MIN) })].filter((c) => !id || c.sessionId === id);
    expect(await stopIdleRunsTick({ candidates, now, stop })).toBe(1);
    expect(stop).toHaveBeenCalledWith('idle-a');
    // 20 minutes at the snapshot clock, 21 at the re-check clock: the log reports the fresher number.
    expect(info).toHaveBeenCalledWith('[dialer] idle run stopped', expect.objectContaining({ sessionId: 'idle-a', idleMinutes: 21 }));
  });

  it('a re-check that throws is logged, and the next idle run is still stopped', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const candidates = async (id?: string) => {
      if (id === 'bad') throw new Error('db down');
      return id ? [run(id)] : [run('bad'), run('good')];
    };
    expect(await stopIdleRunsTick({ candidates, now: () => NOW, stop })).toBe(1);
    expect(stop.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['good']);
    expect(error).toHaveBeenCalledWith('[dialer] idle run stop failed', { sessionId: 'bad', err: 'db down' });
  });

  it('stops nothing, and logs nothing, when no run is idle', async () => {
    const stop = vi.fn(async () => ({ action: 'stopped' as const }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await stopIdleRunsTick(deps([run('r', { lastActivityAt: ago(MIN) })], stop))).toBe(0);
    expect(await stopIdleRunsTick(deps([], stop))).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('liveIdleRunDeps — what the real loop calls', () => {
  it('stops a run through stopIdleSession (flip first), with the engine deps built at call time, and returns its result', async () => {
    const engineDeps = { marker: 'engine-deps' };
    vi.mocked(buildEngineDeps).mockReturnValue(engineDeps as never);
    vi.mocked(stopIdleSession).mockResolvedValue({ action: 'skipped' });
    expect(buildEngineDeps).not.toHaveBeenCalled();
    await expect(liveIdleRunDeps.stop('S9')).resolves.toEqual({ action: 'skipped' });
    expect(stopIdleSession).toHaveBeenCalledTimes(1);
    expect(stopIdleSession).toHaveBeenCalledWith('S9', engineDeps);
  });
});

describe('startIdleRunLoop', () => {
  it('ticks on the interval and is single-flight: a slow tick is never overlapped', async () => {
    vi.useFakeTimers();
    const candidates = vi.fn(() => new Promise<IdleCandidate[]>(() => {}));
    const timer = startIdleRunLoop(1000, { candidates, now: () => NOW, stop: async () => ({ action: 'stopped' }) });
    await vi.advanceTimersByTimeAsync(3500);
    clearInterval(timer);
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('a tick that throws is logged and the next tick still runs', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const candidates = vi.fn(async () => { throw new Error('db down'); });
    const timer = startIdleRunLoop(1000, { candidates, now: () => NOW, stop: async () => ({ action: 'stopped' }) });
    await vi.advanceTimersByTimeAsync(2500);
    clearInterval(timer);
    expect(candidates).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('[dialer] idle run tick failed', { err: 'db down' });
  });
});

describe('maybeStartIdleRunLoop — the DIALER_IDLE_STOP kill switch', () => {
  it('starts on the 30 s interval when on, and never when off', () => {
    const start = vi.fn(() => ({}) as NodeJS.Timeout);
    expect(maybeStartIdleRunLoop({ DIALER_IDLE_STOP: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(maybeStartIdleRunLoop({ DIALER_IDLE_STOP: 'on' }, start)).not.toBeNull();
    expect(start).toHaveBeenCalledWith(IDLE_CHECK_INTERVAL_MS);
    expect(IDLE_CHECK_INTERVAL_MS).toBe(30_000);
  });
});
