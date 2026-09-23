import { describe, expect, it } from 'vitest';
import { cadenceVerdict, COOLDOWN_MS, preferredNumber, rolloverDue, type Dial } from './contact-history.js';
import { DAILY_CAP_WINDOW_MS } from '@cti/firewall';

const NOW = new Date('2026-09-23T18:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const dial = (o: Partial<Dial>): Dial => ({ userId: 'rep-1', sessionId: 'S1', toNumber: '+16195550100', at: ago(60_000), connected: false, source: 'dialer', ...o });
const H = 60 * 60_000;

describe('cadenceVerdict — 3 hours between dials to a person, power dialer only', () => {
  it('ok with no history', () => { expect(cadenceVerdict([], NOW, { sessionId: 'S1', capped: false })).toBe('ok'); });
  it('cooldown: another session dialed within 3 h', () => {
    expect(cadenceVerdict([dial({ sessionId: 'S-other', at: ago(3 * H - 1000) })], NOW, { sessionId: 'S1', capped: false })).toBe('cooldown');
  });
  it('ok: another session dialed exactly 3 h ago (boundary is inclusive of the wait)', () => {
    expect(cadenceVerdict([dial({ sessionId: 'S-other', at: ago(3 * H) })], NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('cooldown: a manual click-to-dial within 3 h counts', () => {
    expect(cadenceVerdict([dial({ sessionId: null, source: 'manual', at: ago(H) })], NOW, { sessionId: 'S1', capped: false })).toBe('cooldown');
  });
  it("ok: this session's own dial does not count (end-of-run retry, rep's Redial)", () => {
    expect(cadenceVerdict([dial({ sessionId: 'S1', at: ago(60_000) })], NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('daily_cap: capped state and 3 dials in 24 h, any rep, any source', () => {
    const d = [dial({ at: ago(23 * H), userId: 'a' }), dial({ at: ago(12 * H), userId: 'b', source: 'manual', sessionId: null }), dial({ at: ago(5 * H), sessionId: 'S1' })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('daily_cap');
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: false })).toBe('ok');
  });
  it('daily_cap: a dial exactly 24 h ago has rolled out of the window', () => {
    const d = [dial({ at: ago(DAILY_CAP_WINDOW_MS) }), dial({ at: ago(12 * H) }), dial({ at: ago(5 * H) })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('ok');
  });
  it('daily_cap wins over cooldown when both apply', () => {
    const d = [dial({ at: ago(10 * H) }), dial({ at: ago(5 * H) }), dial({ sessionId: 'S-other', at: ago(H) })];
    expect(cadenceVerdict(d, NOW, { sessionId: 'S1', capped: true })).toBe('daily_cap');
  });
  it('COOLDOWN_MS is three hours', () => { expect(COOLDOWN_MS).toBe(3 * H); });
});

describe("rolloverDue — the task owner's second miss of the org day", () => {
  const DAY = new Date('2026-09-23T07:00:00Z'); // LA midnight
  it('false with one dial today', () => { expect(rolloverDue([dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false); });
  it('true with two dials today by the owner, neither connected — any source, any session', () => {
    expect(rolloverDue([dial({ at: ago(5 * H), sessionId: 'S-a' }), dial({ at: ago(H), sessionId: null, source: 'manual' })], 'rep-1', DAY)).toBe(true);
  });
  it("false when another rep's dials make up the count", () => {
    expect(rolloverDue([dial({ at: ago(5 * H), userId: 'rep-2' }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
  it('false when any of the owner\'s dials today connected', () => {
    expect(rolloverDue([dial({ at: ago(5 * H), connected: true }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
  it("yesterday's dials do not count", () => {
    expect(rolloverDue([dial({ at: new Date(DAY.getTime() - 1000) }), dial({ at: ago(H) })], 'rep-1', DAY)).toBe(false);
  });
});

describe('preferredNumber — the number that reached them', () => {
  it('the most recent connected dial on one of the record\'s numbers', () => {
    const d = [dial({ toNumber: '+16195550100', connected: true, at: ago(48 * H) }), dial({ toNumber: '+12135550199', connected: true, at: ago(2 * H) })];
    expect(preferredNumber(d, ['+16195550100', '+12135550199'])).toBe('+12135550199');
  });
  it('null when nothing connected, or the connect was on a number the record no longer has', () => {
    expect(preferredNumber([dial({ connected: false })], ['+16195550100'])).toBeNull();
    expect(preferredNumber([dial({ toNumber: '+19995550000', connected: true })], ['+16195550100'])).toBeNull();
  });
});
