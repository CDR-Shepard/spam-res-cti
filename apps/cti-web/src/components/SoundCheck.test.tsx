/** @vitest-environment jsdom */
/**
 * The sound check screen (spec decision 6), with a fake browser. It covers
 * Chrome's three microphone states, the live meter, and the pickers. It also
 * covers the constraint that matters most: the mic stream is always stopped
 * when the check closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SoundCheck, SOUND_CHECK_TEXT } from './SoundCheck';
import type { AudioDevicePort } from '../audio-device-port';
import type { MediaDeviceLike } from '../audio-devices';
import type { LevelSource, MicStreamLike } from '../level-meter';
import type { MicPermission, SoundCheckEnv } from '../sound-check-env';

const DEVICES: MediaDeviceLike[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
  { kind: 'audioinput', deviceId: 'jabra', label: 'Jabra Evolve2 65' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - MacBook Pro Speakers' },
  { kind: 'audiooutput', deviceId: 'spk-jabra', label: 'Jabra Evolve2 65' },
];

function fakePort(): AudioDevicePort {
  return {
    listDevices: vi.fn(async () => DEVICES),
    onDeviceChange: vi.fn(() => () => {}),
    canChooseOutput: vi.fn(() => true),
    setInputDevice: vi.fn(async () => {}),
    unsetInputDevice: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async () => {}),
    playTestSound: vi.fn(async () => {}),
  };
}

interface FakeStream extends MicStreamLike { deviceId: string | null; stopped: boolean }
interface FakeSource extends LevelSource { closed: boolean }

function fakeEnv(initial: MicPermission) {
  const s = {
    change: null as ((p: MicPermission) => void) | null,
    watchStopped: false,
    streams: [] as FakeStream[],
    sources: [] as FakeSource[],
    level: 0.4,
    openError: null as Error | null,
  };
  const env: SoundCheckEnv = {
    watchPermission: async (onChange) => {
      s.change = onChange;
      return { state: initial, stop: () => { s.watchStopped = true; s.change = null; } };
    },
    openMic: vi.fn(async (deviceId: string | null) => {
      if (s.openError) throw s.openError;
      const stream: FakeStream = { deviceId, stopped: false, getTracks: () => [{ stop: () => { stream.stopped = true; } }] };
      s.streams.push(stream);
      return stream;
    }),
    createLevelSource: () => {
      const src: FakeSource = { closed: false, read: () => s.level, close: () => { src.closed = true; } };
      s.sources.push(src);
      return src;
    },
  };
  return { env, s, flip: (p: MicPermission): void => { act(() => { s.change?.(p); }); } };
}

const noop = (): void => {};
function renderCheck(env: SoundCheckEnv, props: { onDone?: () => void; onLater?: () => void } = {}) {
  return render(<SoundCheck port={fakePort()} onToast={noop} onDone={props.onDone ?? noop} onLater={props.onLater ?? noop} env={env} />);
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

describe('SoundCheck — Chrome has not decided (prompt)', () => {
  it('"Allow microphone" asks Chrome, releases that stream at once, then opens the chosen mic for the meter', async () => {
    localStorage.setItem('cti.audio.input', 'jabra');
    const f = fakeEnv('prompt');
    renderCheck(f.env);
    fireEvent.click(await screen.findByRole('button', { name: SOUND_CHECK_TEXT.allow }));
    await screen.findByRole('progressbar', { name: 'Microphone level' });
    expect(screen.getByText(SOUND_CHECK_TEXT.allowed)).toBeTruthy();
    await waitFor(() => expect(f.s.streams).toHaveLength(2));
    expect(f.s.streams[0]).toMatchObject({ deviceId: null, stopped: true });
    expect(f.s.streams[1]).toMatchObject({ deviceId: 'jabra', stopped: false });
  });

  it('a refused popup says why and stays on the Allow screen', async () => {
    const f = fakeEnv('prompt');
    f.s.openError = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    renderCheck(f.env);
    fireEvent.click(await screen.findByRole('button', { name: SOUND_CHECK_TEXT.allow }));
    expect((await screen.findByRole('alert')).textContent).toBe("Chrome didn't allow the microphone. Click Allow microphone, then choose Allow.");
    expect(screen.getByRole('button', { name: SOUND_CHECK_TEXT.allow })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('SoundCheck — Chrome blocks the mic (denied)', () => {
  it('shows how to unblock it, opens nothing, and flips to ✓ the moment it is allowed — no reload', async () => {
    const f = fakeEnv('denied');
    renderCheck(f.env);
    expect(await screen.findByText(SOUND_CHECK_TEXT.deniedTitle)).toBeTruthy();
    expect(screen.getByText(SOUND_CHECK_TEXT.deniedBody)).toBeTruthy();
    expect(screen.queryByRole('button', { name: SOUND_CHECK_TEXT.allow })).toBeNull();
    expect(f.env.openMic).not.toHaveBeenCalled();
    f.flip('granted');
    expect(await screen.findByText(SOUND_CHECK_TEXT.allowed)).toBeTruthy();
    await screen.findByRole('progressbar', { name: 'Microphone level' });
    await waitFor(() => expect(f.s.streams).toHaveLength(1));
  });
});

describe('SoundCheck — allowed (granted)', () => {
  it('the meter follows the mic level', async () => {
    const f = fakeEnv('granted');
    renderCheck(f.env);
    const meter = await screen.findByRole('progressbar', { name: 'Microphone level' });
    await waitFor(() => expect(meter.getAttribute('aria-valuenow')).toBe('40'));
    f.s.level = 0.9;
    await waitFor(() => expect(meter.getAttribute('aria-valuenow')).toBe('90'));
    expect(screen.queryByText(SOUND_CHECK_TEXT.allowed)).toBeNull(); // already allowed: no ✓ flip to show
  });

  it('shows the Microphone and Speaker pickers and the test sound', async () => {
    renderCheck(fakeEnv('granted').env);
    expect(await screen.findByLabelText('Microphone')).toBeTruthy();
    expect(screen.getByLabelText('Speaker')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play test sound' })).toBeTruthy();
  });

  it('picking another mic re-opens the meter on it and releases the old stream', async () => {
    const f = fakeEnv('granted');
    renderCheck(f.env);
    await waitFor(() => expect(f.s.sources).toHaveLength(1));
    const mic = (await screen.findByLabelText('Microphone')) as HTMLSelectElement;
    await waitFor(() => expect([...mic.options].map((o) => o.value)).toContain('jabra'));
    fireEvent.change(mic, { target: { value: 'jabra' } });
    await waitFor(() => expect(f.s.streams).toHaveLength(2));
    expect(f.s.streams[0]!.stopped).toBe(true);
    expect(f.s.sources[0]!.closed).toBe(true);
    expect(f.s.streams[1]).toMatchObject({ deviceId: 'jabra', stopped: false });
  });

  it('"Looks good" finishes it', async () => {
    const onDone = vi.fn();
    renderCheck(fakeEnv('granted').env, { onDone });
    fireEvent.click(await screen.findByRole('button', { name: SOUND_CHECK_TEXT.done }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('SoundCheck — the mic is never left open', () => {
  it('closing the check stops the stream, closes the meter and stops watching the permission', async () => {
    const f = fakeEnv('granted');
    const view = renderCheck(f.env);
    await waitFor(() => expect(f.s.sources).toHaveLength(1));
    view.unmount();
    expect(f.s.streams[0]!.stopped).toBe(true);
    expect(f.s.sources[0]!.closed).toBe(true);
    expect(f.s.watchStopped).toBe(true);
  });

  it('a stream that arrives after the check closed is stopped at once', async () => {
    const f = fakeEnv('granted');
    let resolveOpen: (s: MicStreamLike) => void = () => {};
    const late: MicStreamLike & { stopped: boolean } = { stopped: false, getTracks: () => [{ stop: () => { late.stopped = true; } }] };
    f.env.openMic = vi.fn(() => new Promise<MicStreamLike>((r) => { resolveOpen = r; }));
    const view = renderCheck(f.env);
    await waitFor(() => expect(f.env.openMic).toHaveBeenCalled());
    view.unmount();
    await act(async () => { resolveOpen(late); });
    expect(late.stopped).toBe(true);
  });

  it('"Not now" closes it in every state', async () => {
    for (const state of ['prompt', 'denied', 'granted'] as const) {
      const onLater = vi.fn();
      const view = renderCheck(fakeEnv(state).env, { onLater });
      fireEvent.click(await screen.findByRole('button', { name: SOUND_CHECK_TEXT.later }));
      expect(onLater).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });
});
