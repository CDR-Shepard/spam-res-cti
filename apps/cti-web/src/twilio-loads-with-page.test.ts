import { describe, expect, it } from 'vitest';

// 2026-10-20, Tyler: a softphone tab opened before a deploy signed in after
// it, lazily asked for the Twilio library's old chunk (twilio-<hash>.js), got
// a 404 — each deploy replaces the hashed files — and showed "Inbound calls
// unavailable". The library now loads WITH the page, so a tab always holds a
// copy that matches its own code. This pins that no lazy import comes back.
const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
  query: '?raw', import: 'default', eager: true,
});

describe('the Twilio library loads with the page', () => {
  it('reads the app source (the glob is not silently empty)', () => {
    expect(Object.keys(sources)).toContain('./App.tsx');
  });

  // ANY lazy import is banned, not just the SDK's: a wrapper module that
  // re-exports Device, loaded lazily, splits the SDK back into its own chunk
  // with the same post-deploy 404 — and so would any other lazy chunk.
  it('no source file imports anything lazily', () => {
    const lazy = Object.entries(sources)
      .filter(([, text]) => /\bimport\s*\(/.test(text))
      .map(([path]) => path);
    expect(lazy).toEqual([]);
  });
});
