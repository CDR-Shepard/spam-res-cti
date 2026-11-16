/** @vitest-environment jsdom */
/**
 * The softphone's own panel height in Salesforce. Once Open CTI is ready the
 * app sets the utility panel height itself, which overrides the call center's
 * reqSoftphoneHeight — so this number IS the height reps see. 750 = 25% over
 * the old 600 (2026-11-16), matching the call center's 475 × 750.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';

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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) return jsonResponse(ME);
    if (url.includes('/texts/new')) return jsonResponse({ count: 0 });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/calls?')) return jsonResponse({ calls: [] });
    return jsonResponse({});
  }));
  vi.spyOn(opencti, 'initOpenCti').mockResolvedValue({ ready: true });
  vi.spyOn(opencti, 'onClickToDial').mockImplementation(() => {});
  vi.spyOn(opencti, 'notifyReady').mockImplementation(() => {});
  vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
  vi.spyOn(opencti, 'setPanelHeight').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App — softphone panel size in Salesforce', () => {
  it('grows the panel to 750 px once Open CTI is ready', async () => {
    render(<App />);
    await waitFor(() => expect(opencti.setPanelHeight).toHaveBeenCalled());
    expect(opencti.setPanelHeight).toHaveBeenCalledWith(750);
  });
});
