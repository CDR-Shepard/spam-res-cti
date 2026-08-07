import { describe, expect, it } from 'vitest';
import { electLeader, shouldBeLeader, type Peer } from './leader-election';

const peer = (id: string, visible: boolean, lastSeen: number, busy = false): Peer => ({ id, visible, lastSeen, busy });

describe('electLeader — a tab on a live call keeps the phone', () => {
  it('a BUSY tab beats a visible one, so switching tabs mid-call cannot steal the call', () => {
    // The rep is on a call in this (now hidden) tab and clicks another Salesforce
    // tab to read the record. Leadership must NOT follow them, or the new tab
    // registers a second Device and the live call stalls like it is on hold.
    expect(electLeader({
      selfId: 'oncall', selfVisible: false, selfBusy: true,
      peers: [peer('other', true, 1000)], now: 1000, staleMs: 3000,
    })).toBe('oncall');
  });

  it('the busy tab keeps it even against a visible tab with a smaller id', () => {
    expect(electLeader({
      selfId: 'zzz', selfVisible: false, selfBusy: true,
      peers: [peer('aaa', true, 1000)], now: 1000, staleMs: 3000,
    })).toBe('zzz');
  });

  it('a busy PEER wins too — a non-busy tab must not claim leadership', () => {
    expect(shouldBeLeader({
      selfId: 'aaa', selfVisible: true, selfBusy: false,
      peers: [peer('zzz', false, 1000, true)], now: 1000, staleMs: 3000,
    })).toBe(false);
  });

  it('falls back to visible-then-id once nobody is busy (call ended)', () => {
    expect(electLeader({
      selfId: 'hidden', selfVisible: false, selfBusy: false,
      peers: [peer('shown', true, 1000)], now: 1000, staleMs: 3000,
    })).toBe('shown');
  });

  it('a stale busy peer cannot pin leadership forever (crashed mid-call)', () => {
    expect(electLeader({
      selfId: 'live', selfVisible: true, selfBusy: false,
      peers: [peer('crashed', false, 1000, true)], now: 9000, staleMs: 3000,
    })).toBe('live');
  });
});

describe('electLeader', () => {
  it('a lone instance is always the leader', () => {
    expect(electLeader({ selfId: 'a', selfVisible: false, selfBusy: false, peers: [], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('prefers a visible instance over a hidden one, regardless of id order', () => {
    // self is hidden with the smaller id; the visible peer must still win.
    expect(electLeader({ selfId: 'a', selfVisible: false, selfBusy: false, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('z');
  });

  it('among equally-visible instances, the smallest id wins (deterministic)', () => {
    expect(electLeader({ selfId: 'm', selfVisible: true, selfBusy: false, peers: [peer('a', true, 1000), peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe('a');
  });

  it('ignores stale peers (older than now - staleMs)', () => {
    // 'a' would win but it was last seen 4s ago with staleMs 3s -> excluded.
    expect(electLeader({ selfId: 'm', selfVisible: true, selfBusy: false, peers: [peer('a', true, 1000)], now: 5000, staleMs: 3000 })).toBe('m');
  });

  it('shouldBeLeader is electLeader === selfId', () => {
    expect(shouldBeLeader({ selfId: 'a', selfVisible: true, selfBusy: false, peers: [peer('z', true, 1000)], now: 1000, staleMs: 3000 })).toBe(true);
    expect(shouldBeLeader({ selfId: 'z', selfVisible: false, selfBusy: false, peers: [peer('a', true, 1000)], now: 1000, staleMs: 3000 })).toBe(false);
  });
});
