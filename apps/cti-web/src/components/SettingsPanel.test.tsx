import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HoldMusicChoice, YouTubeRef } from '@cti/contracts';
import { SettingsPanel } from './SettingsPanel';
import type { AudioDevicePort } from '../audio-device-port';

describe('SettingsPanel — hold music during Power Dial', () => {
  const props = { forwardE164: null, onSaved: () => {}, onToast: () => {} };
  const setting = (choice: HoldMusicChoice, youtube: YouTubeRef | null = null) => ({ choice, youtube });

  it('a picker with the eight choices, the current one selected', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={setting('ambient')} />);
    expect(html).toContain('Hold music during Power Dial');
    for (const label of ['Off', 'Classical', 'Ambient', 'Electronica', 'Guitars', 'Rock', 'Soft rock', 'YouTube']) expect(html).toContain(`>${label}</option>`);
    expect(html).toMatch(/<option value="ambient" selected="">Ambient<\/option>/);
    expect(html).not.toContain('Paste a YouTube');
  });

  it('YouTube chosen: the link box shows the saved playlist and says what it is', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={setting('youtube', { listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', videoId: null })} />);
    expect(html).toContain('YouTube · playlist');
    expect(html).toContain('value="https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"');
  });
});

// 2026-09-25: a rep's softphone captured from / played to the wrong device
// (Voice Insights: constant-audio-input-level + constant-audio-output-level).
describe('SettingsPanel — microphone and speaker', () => {
  const props = { forwardE164: null, holdMusic: { choice: 'off' as HoldMusicChoice, youtube: null }, onSaved: () => {}, onToast: () => {} };
  const port = (canChooseOutput: boolean): AudioDevicePort => ({
    listDevices: async () => [],
    onDeviceChange: () => () => {},
    canChooseOutput: () => canChooseOutput,
    setInputDevice: async () => {},
    unsetInputDevice: async () => {},
    setOutputDevice: async () => {},
    playTestSound: async () => {},
  });

  it('a Microphone row and a Speaker row, each a select starting with "System default" (selected)', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} audioDevices={port(true)} />);
    expect(html).toContain('>Microphone</div>');
    expect(html).toContain('>Speaker</div>');
    expect(html).toMatch(/<select aria-label="Microphone"[^>]*><option value="default" selected="">System default<\/option>/);
    expect(html).toMatch(/<select aria-label="Speaker"[^>]*><option value="default" selected="">System default<\/option>/);
    expect(html).toContain('Play test sound');
  });

  it("a browser that can't choose the speaker gets a disabled row that says where to change it", () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} audioDevices={port(false)} />);
    expect(html).toMatch(/<select aria-label="Speaker"[^>]*disabled=""/);
    expect(html).toContain('Your browser picks the speaker (change it in your computer&#x27;s sound settings)');
    expect(html).not.toContain('Play test sound');
  });

  it('renders without an injected port (existing callers)', () => {
    const html = renderToStaticMarkup(<SettingsPanel {...props} />);
    expect(html).toContain('aria-label="Microphone"');
  });
});
