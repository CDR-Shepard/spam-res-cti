/**
 * The voicemail the AMD callback leaves is the org's saved voicemail template rendered for the call (plan
 * 2026-10-16 editable agent prompts, Task 4); a saved template that fails to render falls back to the default
 * voicemail and warns (kind and reason only, never the template). onAmd is called directly with the fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearActiveCalls, registerActiveCall } from './registry.js';
import { onAmd, type WebhookDeps } from './routes-webhooks.js';
import { activeEntry, CALL_SID, fakeStore, fakeTwilio, type FakeStore, type FakeTwilio } from './testing.js';
import { defaultToolEffects } from './service-tools.js';

const ID = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-05T18:00:00Z');
const MARKER = 'SECRET-VOICEMAIL-MARKER';

let store: FakeStore;
let twilio: FakeTwilio;
let warn: ReturnType<typeof vi.fn>;
let deps: WebhookDeps;
let bridge: { start: ReturnType<typeof vi.fn>; silence: ReturnType<typeof vi.fn>; waitForPlayback: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  warn = vi.fn();
  bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(async () => {}), stop: vi.fn() };
  deps = { store, twilio, effects: defaultToolEffects, now: () => NOW, log: { info: vi.fn(), warn, error: vi.fn() }, voicemail: null };
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100', fromE164: '+16195550000', status: 'in_progress', callSid: CALL_SID });
});
afterEach(() => clearActiveCalls());

async function leaveVoicemail(voicemail: string | null): Promise<string> {
  const base = activeEntry({ aiCallId: ID, callSid: CALL_SID, bridge });
  registerActiveCall({ ...base, prompt: { ...base.prompt, templates: { instructions: null, voicemail } } });
  await onAmd((await store.get(ID))!, 'machine_end_beep', deps);
  expect(twilio.redirects).toHaveLength(1);
  return twilio.redirects[0]!.twiml;
}

describe('onAmd — the voicemail text', () => {
  it('is the saved voicemail template rendered for the call', async () => {
    const twiml = await leaveVoicemail('Hi {{first_name}}, it is {{agent_name}} from {{company_name}}. Call {{callback_number}}.');
    expect(twiml).toContain('Hi Jane, it is Alex from GG Homes. Call 619-555-0000.');
    expect(warn).not.toHaveBeenCalled();
    expect(store.rows.get(ID)?.outcome).toBe('voicemail');
  });

  it('is the built-in default when nothing is saved', async () => {
    const twiml = await leaveVoicemail(null);
    expect(twiml).toContain('Hi Jane, this is Alex, an AI assistant calling for GG Homes');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default and warns (kind and reason only) when the saved template fails to render', async () => {
    const twiml = await leaveVoicemail(`${MARKER} {{nope}}`);
    expect(twiml).toContain('Hi Jane, this is Alex, an AI assistant calling for GG Homes');
    expect(twiml).not.toContain(MARKER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ kind: 'voicemail', reason: 'render_error' }, 'ai-voice: custom prompt failed, using default');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
    expect(store.rows.get(ID)?.outcome).toBe('voicemail');
  });

  it('a saved voicemail that renders to nothing for this call is never a silent <Say>: the default is read and the warn says empty_render', async () => {
    // This call has a callback number, so the inverted block hides and the whole text is empty.
    const twiml = await leaveVoicemail(`{{^callback_number}}${MARKER}{{/callback_number}}`);
    expect(twiml).toContain('Hi Jane, this is Alex, an AI assistant calling for GG Homes');
    expect(twiml).not.toContain(MARKER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ kind: 'voicemail', reason: 'empty_render' }, 'ai-voice: custom prompt failed, using default');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MARKER);
  });
});
