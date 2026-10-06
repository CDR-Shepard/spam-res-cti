import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { AI_CALL_ID, CALL_ID, IDENTITY, TEST_ID, recordTest } from '../test/record-test-fixtures';
import { stubApi } from '../test/stub-api';
import { RecordTestRun } from './record-test-run';

/** A live browser call, read by a screen reader (plan 1E): state changes are announced, the ticking clock is not. */
type Fn = (...a: unknown[]) => void;
class Emitter {
  private readonly handlers = new Map<string, Fn[]>();
  on(ev: string, fn: Fn): void { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); }
  emit(ev: string, ...a: unknown[]): void { for (const fn of this.handlers.get(ev) ?? []) fn(...a); }
}
class FakeCall extends Emitter {
  accept = (): void => this.emit('accept');
  mute = vi.fn();
  disconnect = vi.fn();
  reject = vi.fn();
}
class FakeDevice extends Emitter {
  static isSupported = true;
  static last: FakeDevice | null = null;
  constructor() { super(); FakeDevice.last = this; }
  register(): Promise<void> { queueMicrotask(() => this.emit('registered')); return Promise.resolve(); }
  destroy(): void {}
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const AVAILABILITY = 'GET /api/ai-calls/availability';

beforeEach(() => {
  FakeDevice.last = null;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [] }) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

async function goLive(): Promise<FakeCall> {
  const calls = stubApi({
    [AVAILABILITY]: { available: true, testNumbers: ['+15125550111'], browserCalls: true },
    'POST /api/record-tests/browser-token': { token: 'secret.jwt.token', identity: IDENTITY, expiresAt: '2026-10-06T18:00:00.000Z' },
    [`POST /api/record-tests/${TEST_ID}/calls`]: { callId: CALL_ID, response: { result: 'placed', aiCallId: AI_CALL_ID } },
    [`GET /api/record-tests/${TEST_ID}`]: recordTest(),
  });
  renderWithProviders(<RecordTestRun test={recordTest()} />, { isAdmin: true });
  await userEvent.click(await screen.findByRole('button', { name: 'Talk in browser' }));
  await waitFor(() => expect(calls.some((c) => c.url === `/api/record-tests/${TEST_ID}/calls`)).toBe(true));
  await screen.findByText('The AI is calling this browser…');
  const call = new FakeCall();
  act(() => FakeDevice.last!.emit('incoming', call));
  return call;
}

describe('a live browser call, for a screen reader', () => {
  it('the live region says Connected; the ticking clock sits outside it', async () => {
    await goLive();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/^Connected$/);
    expect(status.parentElement).toHaveTextContent('Connected · 0:00');
    const clock = screen.getByText('0:00');
    expect(clock).toHaveAttribute('aria-live', 'off');
    expect(status).not.toContainElement(clock);
  });

  it('Mute is a toggle: aria-pressed follows it, and muting is announced', async () => {
    const call = await goLive();
    const mute = await screen.findByRole('button', { name: 'Mute' });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(mute);
    expect(call.mute).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(/^Connected · muted$/);
    await userEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
  });
});
