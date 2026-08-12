import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CallScreen } from './CallScreen';

const base = {
  toNumber: '+16195551234',
  fromNumber: '+16195550000',
  timer: '00:42',
  muted: false,
  onToggleMute: () => {},
  onHangup: () => {},
  onSendDigit: (_k: string, sent: string) => sent,
};

describe('CallScreen keypad affordance', () => {
  it('offers the keypad once the call is connected (IVRs need a digit to connect)', () => {
    const html = renderToStaticMarkup(<CallScreen {...base} phase="active" />);
    expect(html).toContain('Keypad');
  });

  it('does NOT offer the keypad while still ringing — there is nothing to send a tone to', () => {
    const html = renderToStaticMarkup(<CallScreen {...base} phase="ringing" />);
    expect(html).not.toContain('Keypad');
  });

  it('keeps hangup reachable on the normal call view', () => {
    const html = renderToStaticMarkup(<CallScreen {...base} phase="active" />);
    expect(html).toContain('End call');
  });
});
