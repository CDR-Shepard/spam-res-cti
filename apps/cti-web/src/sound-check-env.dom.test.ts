/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSoundCheckEnv } from './sound-check-env';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => { setVisibility('visible'); });

describe('browserSoundCheckEnv — onHidden (Task 3 review I1)', () => {
  it('fires when the tab goes hidden, not when it comes back; the unsubscribe stops it', () => {
    const cb = vi.fn();
    const off = browserSoundCheckEnv({}).onHidden(cb);
    setVisibility('hidden');
    expect(cb).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    setVisibility('hidden');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('browserSoundCheckEnv — isVisible (re-review item 2)', () => {
  it('reads the tab\'s visibility now', () => {
    const env = browserSoundCheckEnv({});
    setVisibility('hidden');
    expect(env.isVisible()).toBe(false);
    setVisibility('visible');
    expect(env.isVisible()).toBe(true);
  });
});
