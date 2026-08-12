import { describe, expect, it, vi } from 'vitest';
import { sendDtmfKey, isDtmfKey, DTMF_KEYS } from './dtmf';

describe('isDtmfKey', () => {
  it('accepts every real keypad key, including * and #', () => {
    expect(DTMF_KEYS).toHaveLength(12);
    for (const k of DTMF_KEYS) expect(isDtmfKey(k)).toBe(true);
  });

  it('rejects anything that is not a keypad key', () => {
    for (const k of ['a', '', '12', ' ', '+', 'Enter']) expect(isDtmfKey(k)).toBe(false);
  });
});

describe('sendDtmfKey', () => {
  const fakeCall = () => ({ sendDigits: vi.fn() });

  it('sends the tone immediately — an IVR waiting on one digit cannot wait for a batch', () => {
    const call = fakeCall();
    sendDtmfKey(call, '1', '');
    expect(call.sendDigits).toHaveBeenCalledWith('1');
    expect(call.sendDigits).toHaveBeenCalledTimes(1);
  });

  it('sends one tone per press and accumulates the readout in order', () => {
    const call = fakeCall();
    let sent = '';
    for (const k of ['9', '0', '#']) sent = sendDtmfKey(call, k, sent);
    expect(call.sendDigits.mock.calls.map((c) => c[0])).toEqual(['9', '0', '#']);
    expect(sent).toBe('90#');
  });

  it('never sends a non-keypad character', () => {
    const call = fakeCall();
    expect(sendDtmfKey(call, 'a', '5')).toBe('5');
    expect(call.sendDigits).not.toHaveBeenCalled();
  });

  it('is a no-op with no active call', () => {
    expect(sendDtmfKey(null, '1', '')).toBe('');
    expect(sendDtmfKey(undefined, '1', '7')).toBe('7');
  });

  it('survives a call that already ended (sendDigits throws) without showing a false send', () => {
    const call = { sendDigits: vi.fn(() => { throw new Error('call is closed'); }) };
    expect(() => sendDtmfKey(call, '1', '4')).not.toThrow();
    expect(sendDtmfKey(call, '1', '4')).toBe('4');
  });

  it('bounds the readout while still sending every key', () => {
    const call = fakeCall();
    let sent = '';
    for (let i = 0; i < 10; i++) sent = sendDtmfKey(call, '1', sent, 4);
    expect(call.sendDigits).toHaveBeenCalledTimes(10); // all sent
    expect(sent).toBe('1111'); // display trimmed to the most recent
  });
});
