import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakedCommit, formatDeployed, isStaleBuild } from './version';

afterEach(() => vi.unstubAllEnvs());

describe('bakedCommit', () => {
  it('is the 7-character commit the build was given', () => {
    vi.stubEnv('VITE_APP_COMMIT', '8a398bc1f0e2d4c6b8a7e9f01234567890abcdef');
    expect(bakedCommit()).toBe('8a398bc');
  });

  it('is "dev" when the build was given nothing (an empty value, as a Docker build without the arg passes)', () => {
    vi.stubEnv('VITE_APP_COMMIT', '');
    expect(bakedCommit()).toBe('dev');
  });

  it('is "dev" when the variable is not set at all', () => {
    vi.stubEnv('VITE_APP_COMMIT', undefined);
    expect(bakedCommit()).toBe('dev');
  });
});

describe('isStaleBuild', () => {
  it('is true only when the tab and the live app are on different, known commits', () => {
    expect(isStaleBuild('8a398bc', '1234567')).toBe(true);
    expect(isStaleBuild('8a398bc', '8a398bc')).toBe(false);
  });

  it('is false while either side does not know its commit: nothing can be said to be older', () => {
    expect(isStaleBuild('dev', '1234567')).toBe(false);
    expect(isStaleBuild('8a398bc', 'dev')).toBe(false);
    expect(isStaleBuild('dev', 'dev')).toBe(false);
  });
});

describe('formatDeployed', () => {
  it('is a short local date and time', () => {
    expect(formatDeployed('2026-10-13T21:41:00.000Z', 'America/Los_Angeles')).toBe('Oct 13, 2:41 PM');
    expect(formatDeployed('2026-10-14T03:05:00.000Z', 'UTC')).toBe('Oct 14, 3:05 AM');
  });

  it('uses a plain space before AM/PM, whatever the ICU build does', () => {
    expect(formatDeployed('2026-10-13T21:41:00.000Z', 'UTC')).not.toMatch(/ | /);
  });

  it('gives back what it was given when that is not a date', () => {
    expect(formatDeployed('soon')).toBe('soon');
  });
});
