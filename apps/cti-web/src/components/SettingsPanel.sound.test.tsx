/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsPanel } from './SettingsPanel';
import type { AudioDevicePort } from '../audio-device-port';

vi.mock('../api', () => ({ api: vi.fn(async () => ({ devices: [] })) }));

const base = { forwardE164: null, holdMusic: { choice: 'off' as const, youtube: null }, onSaved: () => {}, onToast: () => {} };
afterEach(() => { cleanup(); });

describe('SettingsPanel — Run sound check and Reset my audio', () => {
  it('both buttons hand off to App', () => {
    const run = vi.fn();
    const reset = vi.fn();
    render(<SettingsPanel {...base} onRunSoundCheck={run} onResetAudio={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run sound check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset my audio' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  // Task 3 review M-h: after the sound check closes, only the Microphone and
  // Speaker rows re-mount (to show what was picked there) — an unsaved draft
  // anywhere else in Settings survives.
  it('a new audioEpoch re-reads the saved mic in the audio rows, and keeps the forward-number draft', async () => {
    localStorage.clear();
    const port: AudioDevicePort = {
      listDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'default', label: 'Default mic' },
        { kind: 'audioinput', deviceId: 'jabra', label: 'Jabra mic' },
      ]),
      onDeviceChange: vi.fn(() => () => {}),
      canChooseOutput: vi.fn(() => true),
      setInputDevice: vi.fn(async () => {}),
      unsetInputDevice: vi.fn(async () => {}),
      setOutputDevice: vi.fn(async () => {}),
      playTestSound: vi.fn(async () => {}),
    };
    const view = render(<SettingsPanel {...base} audioDevices={port} audioEpoch={0} />);
    const mic = await screen.findByLabelText('Microphone') as HTMLSelectElement;
    await waitFor(() => expect([...mic.options].map((o) => o.value)).toContain('jabra'));
    expect(mic.value).toBe('default');
    const forward = screen.getByPlaceholderText('+1 555 010 0123 (your mobile)') as HTMLInputElement;
    fireEvent.change(forward, { target: { value: '+16195550000' } });

    localStorage.setItem('cti.audio.input', 'jabra'); // picked in the sound check
    view.rerender(<SettingsPanel {...base} audioDevices={port} audioEpoch={1} />);
    await waitFor(() => expect((screen.getByLabelText('Microphone') as HTMLSelectElement).value).toBe('jabra'));
    expect((screen.getByPlaceholderText('+1 555 010 0123 (your mobile)') as HTMLInputElement).value).toBe('+16195550000');
    localStorage.clear();
  });

  it('without the handlers the row is not shown', () => {
    render(<SettingsPanel {...base} />);
    expect(screen.queryByRole('button', { name: 'Run sound check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset my audio' })).toBeNull();
  });
});
