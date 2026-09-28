/** @vitest-environment jsdom */
/**
 * Ready to dial's run settings (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md), in a mounted
 * panel: the choices start from the rep's saved defaults, "N will be dialed"
 * follows the box as the rep types, Start sends exactly what is on screen, and
 * App hears that the server saved the choices only once it accepted the Start.
 * The pieces are pinned pure/SSR in run-settings.test.ts,
 * RunSettingsBlock.test.tsx and DialerPanel.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, type DialerPanelProps } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerSessionView } from '../dialer-api';
import { ApiError } from '../api';

const READY: DialerSessionView = {
  session: { id: 'sess1', status: 'ready' },
  counts: { total: 202, done: 0, connected: 0, noConnect: 0, skipped: 11, unreachable: 4, pending: 187 },
  currentItem: null,
  skipBreakdown: { already_worked: 9, blocked: 2 },
  firstPassTotal: 202,
};

const noop = (): void => {};
const mount = (props: Partial<DialerPanelProps> = {}) => render(
  <DialerPanel
    sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}}
    onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
    {...props}
  />,
);
const pressed = (name: string): string | null => screen.getByRole('button', { name }).getAttribute('aria-pressed');
const startButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Start dialing' }) as HTMLButtonElement;

describe('Ready to dial — run settings', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("starts from the rep's saved choices, with no saved limit How many is All", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount({ runDefaults: { passes: 1, maxRecords: null, rolloverBusinessDays: 2 } });
    await screen.findByRole('button', { name: 'Once' });
    expect(pressed('Once')).toBe('true');
    expect(pressed('Twice')).toBe('false');
    expect(pressed('In 2 business days')).toBe('true');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('');
  });

  // Controller ruling S2 (spec 2026-09-28): How many is remembered too.
  it('prefills How many from a saved limit, and an untouched Start sends it (ruling S2)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const start = vi.spyOn(dialerApi, 'startDialerRun').mockResolvedValue({ ok: true });
    mount({ runDefaults: { passes: 1, maxRecords: 50, rolloverBusinessDays: 2 } });
    expect((await screen.findByLabelText('How many') as HTMLInputElement).value).toBe('50');
    // The run size stays visible however the box got its value — a remembered
    // limit must not quietly hide behind "All".
    expect(screen.getByText(/^50 will be dialed/)).toBeTruthy();
    fireEvent.click(startButton());
    await waitFor(() => expect(start).toHaveBeenCalledWith('sess1', { passes: 1, maxRecords: 50, rolloverBusinessDays: 2 }));
  });

  it("with no saved choices (an older API) it is today's run: Twice, All, next business day", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    await screen.findByRole('button', { name: 'Twice' });
    expect(pressed('Twice')).toBe('true');
    expect(pressed('Next business day')).toBe('true');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('');
  });

  it('"N will be dialed" follows the box as the rep types, capped at what the list can dial', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    const box = await screen.findByLabelText('How many');
    expect(screen.getByText(/^187 will be dialed/)).toBeTruthy();
    expect(screen.queryByText(/^Whole list:/)).toBeNull();
    fireEvent.change(box, { target: { value: '100' } });
    // Review fix (Important 2, ruling S9): a limit that shrinks the run shows
    // its own line, plus a second, clearly labelled list-wide line.
    expect(screen.getByText('100 will be dialed')).toBeTruthy();
    expect(screen.getByText(/^Whole list: 187 dialable/)).toBeTruthy();
    fireEvent.change(box, { target: { value: '195' } });
    expect(screen.getByText(/^187 will be dialed — the whole list/)).toBeTruthy();
    expect(screen.queryByText(/^Whole list:/)).toBeNull();
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getByText(/^187 will be dialed/)).toBeTruthy();
    expect(screen.queryByText(/^Whole list:/)).toBeNull();
  });

  it('the box keeps digits only, and an out-of-range number holds Start back with the reason', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    mount();
    const box = (await screen.findByLabelText('How many')) as HTMLInputElement;
    fireEvent.change(box, { target: { value: '12a' } });
    expect(box.value).toBe('12');
    fireEvent.change(box, { target: { value: '0' } });
    // The bound is the server's maximum (500), not this list's size (202) —
    // review fix (Important 1).
    expect(screen.getByText('Enter a whole number from 1 to 500, or leave it blank for all.')).toBeTruthy();
    expect(startButton().disabled).toBe(true);
    fireEvent.change(box, { target: { value: '202' } });
    expect(startButton().disabled).toBe(false);
    // A number bigger than this 202-person list is fine too — up to 500.
    fireEvent.change(box, { target: { value: '300' } });
    expect(screen.queryByText(/Enter a whole number/)).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  // Review fix (Important 1): a remembered limit bigger than today's list
  // used to disable Start dead, with no way to dial without first clearing
  // the box. Repro: a saved 100 on a 60-person list.
  it('a remembered limit above the list size stays, Start stays enabled, and the line says so (review fix)', async () => {
    const SIXTY: DialerSessionView = {
      session: { id: 'sess1', status: 'ready' },
      counts: { total: 60, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 60 },
      currentItem: null,
      skipBreakdown: {},
      firstPassTotal: 60,
    };
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(SIXTY);
    mount({ runDefaults: { passes: 2, maxRecords: 100, rolloverBusinessDays: 1 } });
    expect((await screen.findByLabelText('How many') as HTMLInputElement).value).toBe('100');
    expect(screen.getByText('60 will be dialed — the whole list')).toBeTruthy();
    expect(screen.queryByText(/Enter a whole number/)).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it('Start sends exactly what is on screen, then tells App the choices were saved — WITH the settings (review fix, Minor 2)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const start = vi.spyOn(dialerApi, 'startDialerRun').mockResolvedValue({ ok: true });
    const saved = vi.fn();
    mount({ onRunDefaultsSaved: saved });
    fireEvent.click(await screen.findByRole('button', { name: 'Once' }));
    fireEvent.change(screen.getByLabelText('How many'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'In 2 business days' }));
    fireEvent.click(startButton());
    await waitFor(() => expect(start).toHaveBeenCalledWith('sess1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }));
    // Minor fix 2 (spec 2026-09-28 review): App needs the settings themselves
    // so it can merge them into `me` immutably before the network refresh
    // even lands — not just a bare "something changed" signal.
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }));
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("a rep who never touches the settings sends Twice / All / Next business day — today's run", async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const start = vi.spyOn(dialerApi, 'startDialerRun').mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start dialing' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('sess1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }));
  });

  it('a refused Start (409) saved nothing, so App is not told to re-read', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    vi.spyOn(dialerApi, 'startDialerRun').mockRejectedValue(
      new ApiError(409, { error: 'Another power-dial run of yours is still live — stop it first.', activeSessionId: null }),
    );
    const saved = vi.fn();
    mount({ onRunDefaultsSaved: saved });
    fireEvent.click(await screen.findByRole('button', { name: 'Start dialing' }));
    expect(await screen.findByText('Another power-dial run of yours is still live — stop it first.')).toBeTruthy();
    expect(saved).not.toHaveBeenCalled();
  });

  // Review fix (Minor 3, spec 2026-09-28), narrowed by a re-review safety
  // finding: a 400 that names a `field` (Task 1's exact shape for a refused
  // run-settings value) happens before the claim, so there is nothing to
  // stop — the Ready screen stays up with the server's own message, exactly
  // like a 409. A 400 WITHOUT a field is covered at the pure-function level
  // (DialerPanel.test.tsx's startRefusalNeedsNoStop / startDialingSequence
  // tests) — it must still stop, since it can arrive AFTER the claim (a
  // Twilio originate failure).
  it('a refused Start (400 naming a field) shows the server\'s message and leaves the Ready screen up', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    vi.spyOn(dialerApi, 'startDialerRun').mockRejectedValue(
      new ApiError(400, { error: 'Enter a whole number from 1 to 500, or leave it blank for all.', field: 'maxRecords' }),
    );
    const saved = vi.fn();
    mount({ onRunDefaultsSaved: saved });
    fireEvent.click(await screen.findByRole('button', { name: 'Start dialing' }));
    expect(await screen.findByText('Enter a whole number from 1 to 500, or leave it blank for all.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start dialing' })).toBeTruthy(); // still the Ready screen
    expect(saved).not.toHaveBeenCalled();
  });

  it('a running run shows its settings under the progress', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      ...READY,
      session: { id: 'sess1', status: 'active', passes: 1, maxRecords: 100, rolloverBusinessDays: 1 },
      counts: { total: 100, done: 3, connected: 0, noConnect: 3, skipped: 0, unreachable: 0, pending: 97 },
      firstPassTotal: 100,
      skipBreakdown: {},
    });
    mount();
    expect(await screen.findByText('Once · first 100 · missed → next business day')).toBeTruthy();
  });
});

// Important 3 (spec 2026-09-28 review): wiring tests that kill mutations
// M8/M9 (the reseed effect's dependency array), M10 (a new session DOES
// reseed), M18/M19 (the runSize prop reaching CurrentRecord for an active
// limited run).
describe('Ready to dial — run settings wiring (review fix, Important 3)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('a re-render with a NEW runDefaults object does not overwrite what the rep already picked (kills M8/M9)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const { rerender } = render(
      <DialerPanel
        sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}}
        onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
        runDefaults={{ passes: 2, maxRecords: null, rolloverBusinessDays: 1 }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Once' })); // the rep deviates from today's default
    expect(pressed('Once')).toBe('true');
    // A fresh /auth/me lands mid-choice (e.g. beginRun's refresh resolving) —
    // a brand-new object, different values, SAME session. Must not clobber
    // what the rep just picked.
    rerender(
      <DialerPanel
        sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}}
        onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
        runDefaults={{ passes: 1, maxRecords: 50, rolloverBusinessDays: 2 }}
      />,
    );
    expect(pressed('Once')).toBe('true');
    expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('');
    expect(pressed('Next business day')).toBe('true');
  });

  it('a NEW sessionId reseeds the draft from the latest defaults (kills M10)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(READY);
    const { rerender } = render(
      <DialerPanel
        sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}}
        onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
        runDefaults={{ passes: 2, maxRecords: null, rolloverBusinessDays: 1 }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Once' })); // the rep deviates from today's default
    expect(pressed('Once')).toBe('true');
    // A genuinely NEW run, with a fresh runDefaults object too — THIS should
    // reseed, unlike the same-session case above.
    rerender(
      <DialerPanel
        sessionId="sess2" onScreenPop={noop} onStartFromListView={async () => {}}
        onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop}
        runDefaults={{ passes: 2, maxRecords: 75, rolloverBusinessDays: 2 }}
      />,
    );
    await waitFor(() => expect((screen.getByLabelText('How many') as HTMLInputElement).value).toBe('75'));
    expect(pressed('Twice')).toBe('true');
    expect(pressed('In 2 business days')).toBe('true');
  });

  it('an active limited run with a current item gets the runSize prop (kills M18/M19)', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      ...READY,
      session: { id: 'sess1', status: 'active', passes: 1, maxRecords: 100, rolloverBusinessDays: 1, runSize: 100 },
      counts: { total: 100, done: 3, connected: 0, noConnect: 3, skipped: 0, unreachable: 0, pending: 97 },
      currentItem: {
        id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', runPosition: 4,
      },
      firstPassTotal: 100,
      skipBreakdown: {},
    });
    mount();
    expect(await screen.findByText('record 4 of 100')).toBeTruthy();
  });

  // Coordinator update to Minor fix 1: runPosition counts PEOPLE and is null
  // on a retry (attempt 2) — a limited run must never show "N of N" for one.
  // The AttemptBadge ("Attempt 2 of 2") is the retry label; no record-count
  // line, same as today's ordinal-based attempt-2 case.
  it('a retry (attempt 2) in a limited run shows the Attempt 2 badge, never "N of N"', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue({
      ...READY,
      session: { id: 'sess1', status: 'active', passes: 2, maxRecords: 100, rolloverBusinessDays: 1, runSize: 100 },
      counts: { total: 100, done: 3, connected: 0, noConnect: 3, skipped: 0, unreachable: 0, pending: 97 },
      currentItem: {
        id: 'i2', recordId: '00Q2', objectType: 'Lead', status: 'dialing', toNumber: '+16195551235', attempt: 2, runPosition: null,
      },
      firstPassTotal: 100,
      skipBreakdown: {},
    });
    mount();
    expect(await screen.findByText('Attempt 2 of 2')).toBeTruthy();
    expect(screen.queryByText(/^record \d+ of \d+$/)).toBeNull();
  });
});
