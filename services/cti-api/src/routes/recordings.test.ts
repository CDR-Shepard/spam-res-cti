import { describe, expect, it, vi } from 'vitest';
import { resolveRecordingUrl } from './recordings.js';

const ID = '11111111-2222-4333-8444-555555555555';
function fakeDb(call: { recordingUrl: string | null } | undefined, connect: { recordingUrl: string | null } | undefined) {
  return {
    query: {
      calls: { findFirst: vi.fn(async () => call) },
      dialerConnects: { findFirst: vi.fn(async () => connect) },
    },
  } as unknown as Parameters<typeof resolveRecordingUrl>[0];
}

describe('resolveRecordingUrl — one link format for both kinds of call', () => {
  it('a click-to-dial call answers from calls and never reads dialer_connects', async () => {
    const db = fakeDb({ recordingUrl: 'https://api.twilio.com/a.mp3' }, undefined);
    expect(await resolveRecordingUrl(db, ID)).toBe('https://api.twilio.com/a.mp3');
    expect((db as any).query.dialerConnects.findFirst).not.toHaveBeenCalled();
  });
  it('a calls row with no recording yet is null (ids are UUIDs — the two tables never share one)', async () => {
    expect(await resolveRecordingUrl(fakeDb({ recordingUrl: null }, { recordingUrl: 'https://api.twilio.com/b.mp3' }), ID)).toBeNull();
  });
  it('a power-dial call answers from dialer_connects', async () => {
    expect(await resolveRecordingUrl(fakeDb(undefined, { recordingUrl: 'https://api.twilio.com/b.mp3' }), ID)).toBe('https://api.twilio.com/b.mp3');
  });
  it('neither → null', async () => {
    expect(await resolveRecordingUrl(fakeDb(undefined, undefined), ID)).toBeNull();
  });
});
