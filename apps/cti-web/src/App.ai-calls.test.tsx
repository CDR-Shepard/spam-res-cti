/** @vitest-environment jsdom */
/**
 * App wiring for AI voice calls: the "AI call" button beside the click-to-dial
 * verdict, the AI calls tab, and the "AI transfer" tag on the ring screen.
 * Same harness as App.sound-check.test.tsx: only the Twilio SDK module and
 * `fetch` are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';

class FakeDevice {
  static instances: FakeDevice[] = [];
  audio = {
    availableInputDevices: new Map(),
    availableOutputDevices: new Map(),
    inputDevice: null,
    isOutputSelectionSupported: false,
    setInputDevice: async () => {},
    unsetInputDevice: async () => {},
    speakerDevices: { get: () => new Set(), set: async () => {} },
    ringtoneDevices: { get: () => new Set(), set: async () => {} },
    on: () => {},
  };
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(_token: string, _opts: unknown) { FakeDevice.instances.push(this); }
  on(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void {}
  destroy(): void {}
  async connect(): Promise<never> { throw new Error('no human call in these tests'); }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

const ALLOW_VERDICT = {
  decision: 'ALLOW', reasons: [], blockReason: null, requiredScriptId: null, auditId: 'audit-1',
  checks: [], normalizedTo: '+16195551234', fromNumber: '+16195559999',
};

let isAdmin = true;
let availability: unknown = { available: true, testNumbers: ['+16195550100'] };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeDevice.instances.length = 0;
  isAdmin = true;
  availability = { available: true, testNumbers: ['+16195550100'] };
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'admin@example.com' }));
  fetchMock = vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/me')) {
      return jsonResponse({ user: { userId: 'u1', orgId: 'org1', email: 'admin@example.com', isAdmin, powerDialerEnabled: false }, salesforce: { connected: false } });
    }
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/firewall/precall')) return jsonResponse(ALLOW_VERDICT);
    if (url.includes('/ai-calls/availability')) return jsonResponse(availability);
    if (method === 'POST' && url.endsWith('/ai-calls')) return jsonResponse({ aiCallId: 'ai-1', status: 'ringing' }, 201);
    if (url.includes('/ai-calls?limit=')) return jsonResponse({ aiCalls: [] });
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Mount inside a fake Salesforce and hand back the click-to-dial trigger. */
async function mountInSalesforce(): Promise<(e: opencti.ClickToDialEvent) => Promise<void>> {
  let clickToDial: (e: opencti.ClickToDialEvent) => void = () => {};
  vi.spyOn(opencti, 'initOpenCti').mockResolvedValue({ ready: true });
  vi.spyOn(opencti, 'onClickToDial').mockImplementation((h) => { clickToDial = h; });
  vi.spyOn(opencti, 'notifyReady').mockImplementation(() => {});
  vi.spyOn(opencti, 'setPanelHeight').mockImplementation(() => {});
  vi.spyOn(opencti, 'setPanelVisibility').mockImplementation(() => {});
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
  render(<App />);
  await waitFor(() => expect(opencti.onClickToDial).toHaveBeenCalled());
  return async (e) => { await act(async () => { clickToDial(e); }); };
}

const LEAD_CLICK = { number: '+16195551234', recordId: '00Q5e00000AbCdE', recordName: 'Jane Doe', objectType: 'Lead' };

describe('App — AI call button on the click-to-dial verdict', () => {
  it('sits beside Call now for a Lead, and starting it posts the record and opens AI calls', async () => {
    const click = await mountInSalesforce();
    await click(LEAD_CLICK);
    await screen.findAllByRole('button', { name: 'Call now' });
    const aiButton = await screen.findByRole('button', { name: 'AI call' });
    fireEvent.click(aiButton);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/ai-calls') && (i as { method?: string })?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as { body: string }).body)).toEqual({ objectType: 'Lead', recordId: '00Q5e00000AbCdE' });
    });
    expect(await screen.findByText('Test AI call')).toBeTruthy(); // the AI calls tab (admin)
    expect(screen.queryAllByRole('button', { name: 'Call now' })).toHaveLength(0); // the dialer was cleared
  });

  it('derives the object from the id when Salesforce sent none', async () => {
    const click = await mountInSalesforce();
    await click({ number: '+16195551234', recordId: '0065e00000AbCdE' });
    expect(await screen.findByRole('button', { name: 'AI call' })).toBeTruthy();
  });

  it('no AI call for an Account', async () => {
    const click = await mountInSalesforce();
    await click({ number: '+16195551234', recordId: '0015e00000AbCdE', objectType: 'Account' });
    await screen.findAllByRole('button', { name: 'Call now' });
    expect(screen.queryByRole('button', { name: 'AI call' })).toBeNull();
  });

  it('no AI call when AI calling is off — but admins still get the AI calls tab', async () => {
    availability = { available: false, testNumbers: [] };
    const click = await mountInSalesforce();
    await click(LEAD_CLICK);
    await screen.findAllByRole('button', { name: 'Call now' });
    expect(screen.queryByRole('button', { name: 'AI call' })).toBeNull();
    expect(screen.getByRole('button', { name: 'AI calls' })).toBeTruthy();
  });
});

describe('App — AI calls tab', () => {
  it('reps see it only while AI calling is on', async () => {
    isAdmin = false;
    availability = { available: false, testNumbers: [] };
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    await screen.findByRole('button', { name: 'Recent' });
    expect(screen.queryByRole('button', { name: 'AI calls' })).toBeNull();
  });

  it('an API without AI routes shows no tab', async () => {
    fetchMock.mockImplementation(async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes('/auth/me')) return jsonResponse({ user: { userId: 'u1', orgId: 'org1', email: 'a@x', isAdmin: true, powerDialerEnabled: false }, salesforce: { connected: false } });
      if (url.includes('/ai-calls')) return jsonResponse({ error: 'not found' }, 404);
      if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
      return jsonResponse({ pending: null });
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Recent' });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/ai-calls/availability'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'AI calls' })).toBeNull();
  });

  it('a rep opens it and sees their calls, with no test box', async () => {
    isAdmin = false;
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'AI calls' }));
    expect(await screen.findByText('No AI calls yet.')).toBeTruthy();
    expect(screen.queryByText('Test AI call')).toBeNull();
  });
});

describe('App — AI transfer on the ring screen', () => {
  it('shows "AI transfer — <reason>" from the aiTransfer call parameter', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map([['callerName', 'Jane Doe'], ['recordType', 'Lead'], ['aiTransfer', 'wants_offer']]),
      accept: vi.fn(), reject: vi.fn(), disconnect: vi.fn(), on: vi.fn(),
    };
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    await screen.findByTitle('Answer');
    expect(screen.getByText('AI transfer — wants an offer')).toBeTruthy();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
  });
});
