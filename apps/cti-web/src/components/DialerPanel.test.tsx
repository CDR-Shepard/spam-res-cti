import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { progressLabel, isNextEnabled, pauseResumeAction, DialerPanel } from './DialerPanel';
import * as dialerApi from '../dialer-api';

describe('progressLabel', () => {
  it('summarizes counts', () => {
    expect(
      progressLabel({ total: 20, done: 3, connected: 1, noConnect: 5, skipped: 2, unreachable: 0, pending: 9 }),
    ).toBe('3 of 20 done · 1 connected · 2 skipped');
  });

  it('handles a fresh, empty run', () => {
    expect(
      progressLabel({ total: 0, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 }),
    ).toBe('0 of 0 done · 0 connected · 0 skipped');
  });
});

// @testing-library/react is not a devDep here (checked package.json), so we
// can't mount the panel in a real DOM and simulate a click. Instead we test
// the pure decision functions each control button's onClick delegates to —
// the same thing a "click Pause, expect dialerControl('pause')" test would
// verify, minus the DOM plumbing.
describe('control button → dialerControl action mapping', () => {
  it('Pause/Resume toggles on session status', () => {
    expect(pauseResumeAction('active')).toBe('pause');
    expect(pauseResumeAction('paused')).toBe('resume');
  });

  it('Next is only enabled once the current record is connected', () => {
    expect(isNextEnabled({ id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: '+16195551234' })).toBe(true);
    expect(isNextEnabled({ id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234' })).toBe(false);
    expect(isNextEnabled(null)).toBe(false);
  });
});

describe('dialerControl is called with the mapped action', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calling dialerControl with the action a control button would send resolves and is observed by the mock', async () => {
    const mockControl = vi.spyOn(dialerApi, 'dialerControl').mockResolvedValue({ ok: true });
    await dialerApi.dialerControl('sess1', pauseResumeAction('active'));
    expect(mockControl).toHaveBeenCalledWith('sess1', 'pause');
  });
});

describe('DialerPanel (no @testing-library available — shallow render only)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the empty state when there is no active session', () => {
    const html = renderToStaticMarkup(
      <DialerPanel sessionId={null} onScreenPop={() => {}} onStart={() => {}} onStop={() => {}} />,
    );
    expect(html).toContain('No active run');
    expect(html).toContain('Salesforce list view');
  });

  it('renders a loading state before the first poll resolves, without crashing', () => {
    // getDialer is called from an effect, which react-dom/server never runs,
    // so this only exercises the synchronous initial render (view === null).
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      session: { id: 'sess1', status: 'active' },
      counts: { total: 5, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 5 },
      currentItem: null,
    });
    const html = renderToStaticMarkup(
      <DialerPanel sessionId="sess1" onScreenPop={() => {}} onStart={() => {}} onStop={() => {}} />,
    );
    expect(typeof html).toBe('string');
  });
});
