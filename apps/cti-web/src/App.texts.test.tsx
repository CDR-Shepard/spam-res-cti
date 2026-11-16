/** @vitest-environment jsdom */
/**
 * The Texts tab in the real App: every rep has it, it carries a count of texts
 * newer than the last one they saw, and opening it shows the texts and clears
 * the count — for this tab and, through storage, for the rep's other tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';
import { textsSeenKey } from './texts';

class FakeDevice {
  constructor(_token: string, _opts: unknown) {}
  on(): void {}
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void {}
  destroy(): void {}
}
vi.mock('@twilio/voice-sdk', () => ({ get Device() { return FakeDevice; } }));

const ME = {
  user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: false },
  salesforce: { connected: true, name: 'Rep' },
};
const TEXT = {
  id: 'm-1',
  fromE164: '+16195550100',
  toE164: '+16193507799',
  body: 'Is the offer still good?',
  numMedia: 0,
  receivedAt: '2026-11-16T18:00:00.000Z',
  optOut: false,
  salesforce: 'logged',
  senderName: 'Pat Seller',
  openRecordId: '006000000000001AAA',
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let newCount = 2;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  newCount = 2;
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/texts/new')) return jsonResponse({ count: newCount });
    if (url.includes('/texts')) return jsonResponse({ texts: [TEXT] });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/calls?')) return jsonResponse({ calls: [] });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App — Texts tab', () => {
  it('shows the new-text count on the tab, then the texts, and clears the count once seen', async () => {
    render(<App />);
    const tab = await screen.findByRole('button', { name: 'Texts, 2 new' });
    expect(tab.querySelector('.tab-badge')?.textContent).toBe('2');

    newCount = 0;
    fireEvent.click(tab);
    expect(await screen.findByText('Pat Seller')).toBeTruthy();
    expect(screen.getByText('Is the offer still good?')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(textsSeenKey('u1'))).toBe('2026-11-16T18:00:00.000Z'));
    expect(document.querySelector('.tab-badge')).toBeNull();

    // Leaving the tab asks again from the newest text seen: nothing new.
    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    await waitFor(() => {
      const last = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/texts/new')).pop();
      expect(last).toContain(`since=${encodeURIComponent('2026-11-16T18:00:00.000Z')}`);
    });
    expect(screen.getByRole('button', { name: 'Texts' })).toBeTruthy();
    expect(document.querySelector('.tab-badge')).toBeNull();
  });

  it('opens the text\'s record in Salesforce on a tap', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Texts/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Pat Seller/ }));
    expect(opencti.screenPopRecord).toHaveBeenCalledWith('006000000000001AAA');
  });
});
