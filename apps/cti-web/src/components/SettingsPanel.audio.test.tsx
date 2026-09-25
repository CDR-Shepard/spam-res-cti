/** @vitest-environment jsdom */
/**
 * Microphone / speaker choice in Settings, mounted (the SSR cases live in
 * SettingsPanel.test.tsx). The Device's audio API arrives as an injected
 * AudioDevicePort, so these use a fake one.
 *
 * WHY: 2026-09-25, a rep couldn't hear callers and callers couldn't hear him
 * while YouTube played through his headset — Voice Insights showed his mic
 * capturing silence and the call playing to a device he wasn't wearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from './SettingsPanel';
import type { AudioDevicePort } from '../audio-device-port';
import type { MediaDeviceLike } from '../audio-devices';

vi.mock('../api', () => ({ api: vi.fn(async () => ({ ok: true })) }));

const HEADSET_AND_LAPTOP: MediaDeviceLike[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
  { kind: 'audioinput', deviceId: 'jabra', label: 'Jabra Evolve2 65' },
  { kind: 'audioinput', deviceId: 'mac', label: 'MacBook Pro Microphone' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - MacBook Pro Speakers' },
  { kind: 'audiooutput', deviceId: 'spk-jabra', label: 'Jabra Evolve2 65' },
  { kind: 'audiooutput', deviceId: 'spk-mac', label: 'MacBook Pro Speakers' },
];

function fakePort(over: Partial<AudioDevicePort> = {}, devices: MediaDeviceLike[] = HEADSET_AND_LAPTOP) {
  const changeListeners: Array<() => void> = [];
  let list = devices;
  const port = {
    listDevices: vi.fn(async () => list),
    onDeviceChange: vi.fn((cb: () => void) => { changeListeners.push(cb); return () => {}; }),
    canChooseOutput: vi.fn(() => true),
    setInputDevice: vi.fn(async (_id: string) => {}),
    unsetInputDevice: vi.fn(async () => {}),
    setOutputDevice: vi.fn(async (_id: string) => {}),
    playTestSound: vi.fn(async (_id: string) => {}),
    ...over,
  };
  return {
    port,
    /** Plug/unplug: swap the list and fire navigator.mediaDevices 'devicechange'. */
    changeDevices: (next: MediaDeviceLike[]) => { list = next; changeListeners.forEach((cb) => cb()); },
  };
}

const onToast = vi.fn();
function renderPanel(port: AudioDevicePort) {
  return render(
    <SettingsPanel
      forwardE164={null}
      holdMusic={{ choice: 'off', youtube: null }}
      onSaved={() => {}}
      onToast={onToast}
      audioDevices={port}
    />,
  );
}
const mic = () => screen.getByLabelText('Microphone') as HTMLSelectElement;
const speaker = () => screen.getByLabelText('Speaker') as HTMLSelectElement;
const optionLabels = (s: HTMLSelectElement) => [...s.options].map((o) => o.textContent);

describe('SettingsPanel — microphone and speaker', () => {
  beforeEach(() => { localStorage.clear(); onToast.mockReset(); });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it('lists each kind by label with "System default" first', async () => {
    renderPanel(fakePort().port);
    await waitFor(() => expect(optionLabels(mic())).toEqual(['System default', 'Jabra Evolve2 65', 'MacBook Pro Microphone']));
    expect(optionLabels(speaker())).toEqual(['System default', 'Jabra Evolve2 65', 'MacBook Pro Speakers']);
  });

  it('highlights the saved choices', async () => {
    localStorage.setItem('cti.audio.input', 'jabra');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    renderPanel(fakePort().port);
    await waitFor(() => expect(mic().value).toBe('jabra'));
    expect(speaker().value).toBe('spk-jabra');
  });

  it('choosing a mic applies it to the Device and saves it', async () => {
    const { port } = fakePort();
    renderPanel(port);
    await waitFor(() => expect(mic().options.length).toBe(3));
    fireEvent.change(mic(), { target: { value: 'jabra' } });
    await waitFor(() => expect(port.setInputDevice).toHaveBeenCalledWith('jabra'));
    expect(localStorage.getItem('cti.audio.input')).toBe('jabra');
    expect(mic().value).toBe('jabra');
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('"System default" for the mic calls unsetInputDevice and forgets the saved device', async () => {
    localStorage.setItem('cti.audio.input', 'jabra');
    const { port } = fakePort();
    renderPanel(port);
    await waitFor(() => expect(mic().value).toBe('jabra'));
    fireEvent.change(mic(), { target: { value: 'default' } });
    await waitFor(() => expect(port.unsetInputDevice).toHaveBeenCalled());
    expect(port.setInputDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem('cti.audio.input')).toBeNull();
  });

  it('choosing a speaker applies it and saves it', async () => {
    const { port } = fakePort();
    renderPanel(port);
    await waitFor(() => expect(speaker().options.length).toBe(3));
    fireEvent.change(speaker(), { target: { value: 'spk-jabra' } });
    await waitFor(() => expect(port.setOutputDevice).toHaveBeenCalledWith('spk-jabra'));
    expect(localStorage.getItem('cti.audio.output')).toBe('spk-jabra');
  });

  it('a saved device that is not connected: says so, shows System default, and keeps the saved choice', async () => {
    localStorage.setItem('cti.audio.input', 'unplugged-headset');
    renderPanel(fakePort().port);
    expect(await screen.findByText('Saved device not connected — using system default')).toBeTruthy();
    expect(mic().value).toBe('default');
    expect(localStorage.getItem('cti.audio.input')).toBe('unplugged-headset');
  });

  it('re-lists when a device is plugged in, and the note clears when the saved one returns', async () => {
    localStorage.setItem('cti.audio.input', 'jabra');
    const withoutJabra = HEADSET_AND_LAPTOP.filter((d) => d.deviceId !== 'jabra');
    const { port, changeDevices } = fakePort({}, withoutJabra);
    renderPanel(port);
    expect(await screen.findByText('Saved device not connected — using system default')).toBeTruthy();
    await act(async () => { changeDevices(HEADSET_AND_LAPTOP); });
    await waitFor(() => expect(mic().value).toBe('jabra'));
    expect(screen.queryByText('Saved device not connected — using system default')).toBeNull();
  });

  it("unsupported output: the Speaker row is disabled and says where to change it", async () => {
    const { port } = fakePort({ canChooseOutput: vi.fn(() => false) });
    renderPanel(port);
    expect(speaker().disabled).toBe(true);
    expect(screen.getByText("Your browser picks the speaker (change it in your computer's sound settings)")).toBeTruthy();
    expect(screen.queryByText('Play test sound')).toBeNull();
  });

  it('hidden labels (no microphone permission yet) ask for access', async () => {
    const blank: MediaDeviceLike[] = [{ kind: 'audioinput', deviceId: '', label: '' }, { kind: 'audiooutput', deviceId: '', label: '' }];
    localStorage.setItem('cti.audio.input', 'jabra');
    renderPanel(fakePort({}, blank).port);
    expect((await screen.findAllByText('Allow microphone access to see device names')).length).toBeGreaterThan(0);
    // Without permission we can't tell whether the saved device is there — don't claim it's gone.
    expect(screen.queryByText('Saved device not connected — using system default')).toBeNull();
  });

  it('a mic the Device refuses shows an error toast', async () => {
    const { port } = fakePort({ setInputDevice: vi.fn(async () => { throw new Error('Could not start audio source'); }) });
    renderPanel(port);
    await waitFor(() => expect(mic().options.length).toBe(3));
    fireEvent.change(mic(), { target: { value: 'jabra' } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      text: "Couldn't switch to that microphone: Could not start audio source",
      type: 'error',
    }));
  });

  // The select must never claim a device the softphone isn't using — that is
  // the exact confusion this feature exists to end.
  it('a refused switch puts the select AND the saved choice back', async () => {
    localStorage.setItem('cti.audio.input', 'mac');
    const { port } = fakePort({ setInputDevice: vi.fn(async () => { throw new Error('Could not start audio source'); }) });
    renderPanel(port);
    await waitFor(() => expect(mic().value).toBe('mac'));
    fireEvent.change(mic(), { target: { value: 'jabra' } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(mic().value).toBe('mac');
    expect(localStorage.getItem('cti.audio.input')).toBe('mac');
  });

  it('a refused speaker switch is put back too', async () => {
    const { port } = fakePort({ setOutputDevice: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    renderPanel(port);
    await waitFor(() => expect(speaker().options.length).toBe(3));
    fireEvent.change(speaker(), { target: { value: 'spk-jabra' } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(speaker().value).toBe('default');
    expect(localStorage.getItem('cti.audio.output')).toBeNull();
  });

  it('a choice made in another tab updates these rows', async () => {
    renderPanel(fakePort().port);
    await waitFor(() => expect(mic().options.length).toBe(3));
    localStorage.setItem('cti.audio.input', 'jabra');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'cti.audio.input', newValue: 'jabra' })); });
    await waitFor(() => expect(mic().value).toBe('jabra'));
  });

  it('"Play test sound" plays on the selected speaker', async () => {
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    const { port } = fakePort();
    renderPanel(port);
    await waitFor(() => expect(speaker().value).toBe('spk-jabra'));
    fireEvent.click(screen.getByText('Play test sound'));
    await waitFor(() => expect(port.playTestSound).toHaveBeenCalledWith('spk-jabra'));
  });
});
