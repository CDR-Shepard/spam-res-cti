import { describe, expect, it, vi, beforeEach } from 'vitest';
import { dialerControlPath, startBody, startDialer, getDialer, dialerControl, getPendingHandoff } from './dialer-api';
import * as apiModule from './api';

describe('dialer-api path/body builders', () => {
  it('builds control paths and a start body', () => {
    expect(dialerControlPath('abc', 'pause')).toBe('/dialer/sessions/abc/pause');
    expect(dialerControlPath('abc', 'next')).toBe('/dialer/sessions/abc/next');
    expect(startBody('Lead', ['00Q1', '00Q2'])).toEqual({ objectType: 'Lead', recordIds: ['00Q1', '00Q2'] });
  });
});

describe('dialer-api async functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('startDialer calls api with POST to /dialer/sessions', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ sessionId: 'session123', total: 10 });

    const result = await startDialer('Lead', ['00Q1', '00Q2']);

    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions', {
      method: 'POST',
      body: { objectType: 'Lead', recordIds: ['00Q1', '00Q2'] }
    });
    expect(result).toEqual({ sessionId: 'session123', total: 10 });
  });

  it('getDialer calls api with GET to /dialer/sessions/:id', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({
      session: { id: 'abc', status: 'active' },
      counts: { total: 10, done: 2, connected: 1, noConnect: 1, skipped: 0, unreachable: 0, pending: 8 },
      currentItem: { id: 'item1', recordId: '00Q1', objectType: 'Lead', status: 'active', toNumber: '555-1234' }
    });

    const result = await getDialer('abc');

    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/abc', {
      method: 'GET'
    });
    expect(result.session.id).toBe('abc');
    expect(result.counts.total).toBe(10);
  });

  it('dialerControl calls api with POST to /dialer/sessions/:id/:action', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true });

    const result = await dialerControl('abc', 'pause');

    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/abc/pause', {
      method: 'POST'
    });
    expect(result).toEqual({ ok: true });
  });

  it('getPendingHandoff calls api with GET to /dialer/handoffs/pending', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({
      handoff: { objectType: 'Lead', recordIds: ['00Q1'] }
    });

    const result = await getPendingHandoff();

    expect(mockApi).toHaveBeenCalledWith('/dialer/handoffs/pending', {
      method: 'GET'
    });
    expect(result).toEqual({ handoff: { objectType: 'Lead', recordIds: ['00Q1'] } });
  });

  it('getPendingHandoff returns a null handoff as-is', async () => {
    vi.spyOn(apiModule, 'api').mockResolvedValue({ handoff: null });

    const result = await getPendingHandoff();

    expect(result).toEqual({ handoff: null });
  });
});
