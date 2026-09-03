import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IncomingScreen } from './IncomingScreen';

const base = {
  from: '+16195551234',
  onAccept: () => {},
  onDecline: () => {},
};

describe('IncomingScreen — Salesforce caller-match rendering', () => {
  it('shows the name on line 1 and "number · recordType" on line 2 when both are present', () => {
    const html = renderToStaticMarkup(
      <IncomingScreen {...base} callerName="Jane Doe" recordType="Lead" />,
    );
    expect(html).toContain('Jane Doe');
    expect(html).toContain('+1 (619) 555-1234');
    expect(html).toContain('Jane Doe');
    expect(html).toMatch(/\+1 \(619\) 555-1234\s*·\s*Lead/);
  });

  it('shows the name on line 1 and just the formatted number on line 2 when there is no record type', () => {
    const html = renderToStaticMarkup(<IncomingScreen {...base} callerName="Jane Doe" />);
    expect(html).toContain('Jane Doe');
    expect(html).not.toContain('·');
    expect(html).toContain('+1 (619) 555-1234');
  });

  it('renders exactly today\'s output for an unmatched caller — formatted number and "Incoming call…"', () => {
    const html = renderToStaticMarkup(<IncomingScreen {...base} />);
    expect(html).toContain('+1 (619) 555-1234');
    expect(html).toContain('Incoming call');
    expect(html).not.toContain('·');
  });

  it('falls back to "Unknown caller" when there is no number either (today\'s rendering, unchanged)', () => {
    const html = renderToStaticMarkup(<IncomingScreen onAccept={() => {}} onDecline={() => {}} />);
    expect(html).toContain('Unknown caller');
    expect(html).toContain('Incoming call');
  });
});
