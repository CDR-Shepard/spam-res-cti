import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SettingsPanel } from './SettingsPanel';

describe('SettingsPanel — hold music during Power Dial', () => {
  const props = { forwardE164: null, onSaved: () => {}, onToast: () => {} };

  it('renders the hold-music switch reflecting the rep preference', () => {
    const on = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={true} />);
    expect(on).toContain('Hold music during Power Dial');
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(on).toContain('Hold music: On');

    const off = renderToStaticMarkup(<SettingsPanel {...props} holdMusic={false} />);
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).toContain('Hold music: Off');
  });
});
