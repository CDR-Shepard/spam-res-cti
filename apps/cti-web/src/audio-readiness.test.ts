import { describe, expect, it, vi } from 'vitest';
import {
  mediaIssueForWarning,
  MEDIA_ISSUE_MESSAGE,
  watchCallMedia,
  prewarmMic,
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

describe('prewarmMic', () => {
  it('resolves true and releases the primed tracks when the mic is granted', async () => {
    const stop = vi.fn();
    const getMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    await expect(prewarmMic(getMedia)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('resolves false (never throws) when the mic is denied — callers must surface this', async () => {
    const getMedia = vi.fn(async () => { throw new Error('NotAllowedError'); });
    await expect(prewarmMic(getMedia)).resolves.toBe(false);
  });
});
