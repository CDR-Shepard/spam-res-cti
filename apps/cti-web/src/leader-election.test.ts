import { describe, expect, it } from 'vitest';
import { electLeader, shouldBeLeader, type Peer } from './leader-election';

const peer = (id: string, visible: boolean, lastSeen: number): Peer => ({ id, visible, lastSeen });

describe('electLeader', () => {
  it('a lone instance is always the leader', () => {
    expect(electLeader({ selfId: 'a', selfVisible: false, peers: [], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('prefers a visible instance over a hidden one, regardless of id order', () => {
    // self is hidden with the smaller id; the visible peer must still win.
    expect(electLeader({ selfId: 'a', selfVisible: false, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('z');
  });

  it('among equally-visible instances, the smallest id wins (deterministic)', () => {
    expect(electLeader({ selfId: 'm', selfVisible: true, peers: [peer('a', true, 1000), peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('ignores stale peers (older than now - staleMs)', () => {
    // 'a' would win but it was last seen 4s ago with staleMs 3s -> excluded.
    expect(electLeader({ selfId: 'm', selfVisible: true, peers: [peer('a', true, 1000)], now: 5000, staleMs: 3000 })).toBe('m');
  });

  it('shouldBeLeader is electLeader === selfId', () => {
    expect(shouldBeLeader({ selfId: 'a', selfVisible: true, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe(true);
    expect(shouldBeLeader({ selfId: 'z', selfVisible: false, peers: [peer('a', true, 1000)], now: 1000, staleMs: 3000 })).toBe(false);
  });
});
