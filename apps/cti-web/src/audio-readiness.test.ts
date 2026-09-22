import { describe, expect, it, vi } from 'vitest';
import {
  mediaIssueForWarning,
  MEDIA_ISSUE_MESSAGE,
  watchCallMedia,
  type MediaIssue,
} from './audio-readiness';

describe('mediaIssueForWarning', () => {
  it('maps the SDK dead-direction warnings, telling us WHICH side is silent', () => {
    // This distinction is the diagnosis: inbound = nothing arrived from the far
    // end (what reps report as "I answered and heard nothing").
    expect(mediaIssueForWarning('low-bytes-received')).toBe('no-inbound-audio');
    expect(mediaIssueForWarning('low-bytes-sent')).toBe('no-outbound-audio');
  });

  it('ignores quality warnings — they are not a dead call', () => {
    for (const n of ['high-jitter', 'high-rtt', 'high-packet-loss', 'low-mos', 'constant-audio-input-level']) {
      expect(mediaIssueForWarning(n)).toBeNull();
    }
  });

  it('has actionable copy for both issues', () => {
    for (const issue of ['no-inbound-audio', 'no-outbound-audio'] as MediaIssue[]) {
      expect(MEDIA_ISSUE_MESSAGE[issue].length).toBeGreaterThan(20);
    }
    expect(MEDIA_ISSUE_MESSAGE['no-inbound-audio']).toMatch(/caller/i);
    expect(MEDIA_ISSUE_MESSAGE['no-outbound-audio']).toMatch(/microphone/i);
  });
});

describe('watchCallMedia', () => {
  /** Minimal fake Twilio Call that records listeners and can emit to them. */
  function fakeCall() {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    return {
      on: (e: string, cb: (...a: unknown[]) => void) => { (listeners[e] ??= []).push(cb); },
      emit: (e: string, ...a: unknown[]) => (listeners[e] ?? []).forEach((cb) => cb(...a)),
    };
  }

  it('reports a dead inbound direction when the SDK raises low-bytes-received', () => {
    const call = fakeCall();
    const onIssue = vi.fn();
    watchCallMedia(call, onIssue);
    call.emit('warning', 'low-bytes-received', { threshold: { name: 'min' } });
    expect(onIssue).toHaveBeenCalledWith('no-inbound-audio');
  });

  it('reports a dead outbound direction (our mic) separately', () => {
    const call = fakeCall();
    const onIssue = vi.fn();
    watchCallMedia(call, onIssue);
    call.emit('warning', 'low-bytes-sent');
    expect(onIssue).toHaveBeenCalledWith('no-outbound-audio');
  });

  it('stays quiet for quality warnings', () => {
    const call = fakeCall();
    const onIssue = vi.fn();
    watchCallMedia(call, onIssue);
    call.emit('warning', 'high-jitter');
    call.emit('warning', 'high-rtt');
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('notifies recovery when the warning clears', () => {
    const call = fakeCall();
    const onCleared = vi.fn();
    watchCallMedia(call, vi.fn(), onCleared);
    call.emit('warning-cleared', 'low-bytes-received');
    expect(onCleared).toHaveBeenCalledWith('no-inbound-audio');
  });

  it('survives a malformed/non-string warning payload', () => {
    const call = fakeCall();
    const onIssue = vi.fn();
    watchCallMedia(call, onIssue);
    expect(() => call.emit('warning', undefined)).not.toThrow();
    expect(() => call.emit('warning', { name: 'bytesReceived' })).not.toThrow();
    expect(onIssue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Local mic re-pinning (2026-09-22: "they can't hear me" after a headset swap)
// ---------------------------------------------------------------------------
import { pickInputDevice, repinInputDevice, watchLocalMic, type AudioHelperLike } from './audio-readiness';

function fakeTrack() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    kind: 'audio',
    readyState: 'live',
    addEventListener: (e: string, cb: () => void) => { (listeners[e] ??= []).push(cb); },
    fire: (e: string) => (listeners[e] ?? []).forEach((cb) => cb()),
  };
}

function fakeAudio(over: Partial<AudioHelperLike> & { forced?: boolean } = {}) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }], ['abc', { deviceId: 'abc' }]]),
    inputDevice: null as { deviceId: string } | null,
    setInputDevice: vi.fn(async (id: string) => { audio.inputDevice = { deviceId: id }; }),
    on: (e: string, cb: (...a: unknown[]) => void) => { (listeners[e] ??= []).push(cb); },
    emit: (e: string, ...a: unknown[]) => (listeners[e] ?? []).forEach((cb) => cb(...a)),
    ...over,
  };
  return audio;
}

describe('pickInputDevice', () => {
  it("prefers Chrome's 'default' pseudo-device (it follows the OS default), else the first real device, else null", () => {
    expect(pickInputDevice(new Map([['abc', { deviceId: 'abc' }], ['default', { deviceId: 'default' }]]))).toBe('default');
    expect(pickInputDevice(new Map([['abc', { deviceId: 'abc' }], ['def', { deviceId: 'def' }]]))).toBe('abc');
    expect(pickInputDevice(new Map())).toBeNull();
  });
});

describe('repinInputDevice', () => {
  it('pins the current default when nothing is pinned yet (the common case: the SDK was using the default stream)', async () => {
    const audio = fakeAudio();
    expect(await repinInputDevice(audio)).toBe('repinned');
    expect(audio.setInputDevice).toHaveBeenCalledWith('default');
  });

  // The public setInputDevice returns early when the SAME device is already
  // pinned and a stream exists — even if that stream's track is dead. The SDK's
  // own device-change path uses its forced variant; so do we, when it exists.
  it('when already pinned to that device, forces a fresh getUserMedia through the SDK\'s forced variant', async () => {
    const forced = vi.fn(async () => {});
    const audio = fakeAudio({ inputDevice: { deviceId: 'default' } });
    (audio as unknown as { _setInputDevice: typeof forced })._setInputDevice = forced;
    expect(await repinInputDevice(audio)).toBe('repinned');
    expect(forced).toHaveBeenCalledWith('default', true);
    expect(audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('when already pinned and no forced variant exists, swaps to another real device and back (two getUserMedia calls)', async () => {
    const audio = fakeAudio({ inputDevice: { deviceId: 'default' } });
    expect(await repinInputDevice(audio)).toBe('repinned');
    expect(vi.mocked(audio.setInputDevice).mock.calls.map((c) => c[0])).toEqual(['abc', 'default']);
  });

  it('reports no-device when nothing is available, and failed (never throws) when the SDK rejects', async () => {
    expect(await repinInputDevice(fakeAudio({ availableInputDevices: new Map() }))).toBe('no-device');
    const audio = fakeAudio({ setInputDevice: vi.fn(async () => { throw new Error('NotAllowedError'); }) });
    expect(await repinInputDevice(audio)).toBe('failed');
  });
});

describe('watchLocalMic', () => {
  const callWith = (track: ReturnType<typeof fakeTrack> | null) => ({
    getLocalStream: () => (track ? { getAudioTracks: () => [track] } : null),
  });

  it("re-pins the mic when the call's local audio track ENDS (headset unplugged) and tells the caller", async () => {
    const track = fakeTrack(); const audio = fakeAudio(); const onRepin = vi.fn();
    watchLocalMic(callWith(track), audio, onRepin);
    track.fire('ended');
    await Promise.resolve(); await Promise.resolve();
    expect(audio.setInputDevice).toHaveBeenCalledWith('default');
    expect(onRepin).toHaveBeenCalledWith('track-ended', 'repinned');
  });

  it('re-pins on a MUTED track too (some headsets mute rather than end when they go away)', async () => {
    const track = fakeTrack(); const audio = fakeAudio(); const onRepin = vi.fn();
    watchLocalMic(callWith(track), audio, onRepin);
    track.fire('mute');
    await Promise.resolve(); await Promise.resolve();
    expect(onRepin).toHaveBeenCalledWith('track-muted', 'repinned');
  });

  // The SDK re-acquires the default device itself on a device change ONLY in
  // browsers that expose the 'default' pseudo-device. Our own listener covers
  // the rest — and is harmless where the SDK already did it.
  it('re-pins when the device list changes', async () => {
    const audio = fakeAudio(); const onRepin = vi.fn();
    watchLocalMic(callWith(fakeTrack()), audio, onRepin);
    audio.emit('deviceChange', []);
    await Promise.resolve(); await Promise.resolve();
    expect(onRepin).toHaveBeenCalledWith('device-change', 'repinned');
  });

  it('a call with no local stream (not connected yet, or an SDK without getLocalStream) still watches device changes', () => {
    const audio = fakeAudio();
    expect(() => watchLocalMic({}, audio, vi.fn())).not.toThrow();
    expect(() => watchLocalMic(callWith(null), audio, vi.fn())).not.toThrow();
  });

  it('re-pins at most once per second: a storm of track/device events is one getUserMedia', async () => {
    const track = fakeTrack(); const audio = fakeAudio(); const onRepin = vi.fn();
    watchLocalMic(callWith(track), audio, onRepin, () => 1000);
    track.fire('ended'); track.fire('mute'); audio.emit('deviceChange', []);
    await Promise.resolve(); await Promise.resolve();
    expect(audio.setInputDevice).toHaveBeenCalledTimes(1);
  });
});
