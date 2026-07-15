import { describe, expect, it } from 'vitest';
import { allTerminal, inFlightItem, nextPendingItem, outcomeToStatus } from './state.js';
import type { DialerItem } from './session-store.js';

const it_ = (o: Partial<DialerItem>): DialerItem => ({ id: 'x', ordinal: 0, status: 'pending', callId: null, toNumber: '+1', ...o } as DialerItem);

describe('pure state helpers', () => {
  it('inFlightItem finds a dialing/connected item, else null', () => {
    expect(inFlightItem([it_({ status: 'done' }), it_({ id: 'a', status: 'dialing' })])?.id).toBe('a');
    expect(inFlightItem([it_({ id: 'b', status: 'connected' })])?.id).toBe('b');
    expect(inFlightItem([it_({ status: 'pending' }), it_({ status: 'done' })])).toBeNull();
  });
  it('nextPendingItem returns the lowest-ordinal pending', () => {
    const picked = nextPendingItem([
      it_({ id: 'a', ordinal: 2, status: 'pending' }),
      it_({ id: 'b', ordinal: 0, status: 'done' }),
      it_({ id: 'c', ordinal: 1, status: 'pending' }),
    ]);
    expect(picked?.id).toBe('c');
  });
  it('outcomeToStatus maps 1:1', () => {
    expect(outcomeToStatus('connected')).toBe('connected');
    expect(outcomeToStatus('no_connect')).toBe('no_connect');
  });
  it('allTerminal is false while work remains', () => {
    expect(allTerminal([it_({ status: 'done' }), it_({ status: 'skipped' }), it_({ status: 'unreachable' })])).toBe(true);
    expect(allTerminal([it_({ status: 'done' }), it_({ status: 'pending' })])).toBe(false);
    expect(allTerminal([it_({ status: 'connected' })])).toBe(false);
  });
});
