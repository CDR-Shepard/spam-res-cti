import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HoldMusicChoice, YouTubeRef } from '@cti/contracts';
import { SettingsPanel } from './SettingsPanel';

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
