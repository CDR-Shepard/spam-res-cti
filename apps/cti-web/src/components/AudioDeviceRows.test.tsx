/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AudioDeviceRows } from './AudioDeviceRows';
import type { AudioDevicePort } from '../audio-device-port';
import type { MediaDeviceLike } from '../audio-devices';

const DEVICES: MediaDeviceLike[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
  { kind: 'audioinput', deviceId: 'jabra', label: 'Jabra Evolve2 65' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - MacBook Pro Speakers' },
];

function fakePort(over: Partial<AudioDevicePort> = {}): AudioDevicePort {
  return {
    listDevices: async () => DEVICES,
    onDeviceChange: () => () => {},
    canChooseOutput: () => true,
    setInputDevice: async () => {},
    unsetInputDevice: async () => {},
    setOutputDevice: async () => {},
    playTestSound: async () => {},
    ...over,
  };
}

async function pickJabra(): Promise<void> {
  const mic = screen.getByLabelText('Microphone') as HTMLSelectElement;
  await waitFor(() => expect([...mic.options].map((o) => o.value)).toContain('jabra'));
  fireEvent.change(mic, { target: { value: 'jabra' } });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

describe('AudioDeviceRows — onChange (the sound check follows the chosen mic)', () => {
  it('tells onChange the new choice', async () => {
    const onChange = vi.fn();
    render(<AudioDeviceRows port={fakePort()} onToast={() => {}} onChange={onChange} />);
    await pickJabra();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ input: 'jabra', output: null }));
  });

  it('and the previous choice again when the Device refuses it', async () => {
    const onChange = vi.fn();
    const refuse = fakePort({ setInputDevice: async () => { throw new Error('in use'); } });
    render(<AudioDeviceRows port={refuse} onToast={() => {}} onChange={onChange} />);
    await pickJabra();
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ input: null, output: null }));
    expect(onChange).toHaveBeenNthCalledWith(1, { input: 'jabra', output: null });
  });
});
