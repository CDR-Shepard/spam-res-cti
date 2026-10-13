import { describe, expect, it } from 'vitest';
import { currentBuild } from './build-info.js';

const FULL_SHA = '8a398bc1f0e2d4c6b8a7e9f01234567890abcdef';

describe('currentBuild', () => {
  it('reports the 7-character commit Railway injects', () => {
    expect(currentBuild({ RAILWAY_GIT_COMMIT_SHA: FULL_SHA }).commit).toBe('8a398bc');
  });

  it.each([{}, { RAILWAY_GIT_COMMIT_SHA: '' }, { RAILWAY_GIT_COMMIT_SHA: 'not a sha' }])('is "dev" for %j', (env) => {
    expect(currentBuild(env).commit).toBe('dev');
  });

  it('reports when this process started: an ISO time in the past that does not move between calls', () => {
    const first = currentBuild({});
    const started = new Date(first.startedAt);
    expect(first.startedAt).toBe(started.toISOString());
    expect(started.getTime()).toBeLessThanOrEqual(Date.now());
    expect(currentBuild({}).startedAt).toBe(first.startedAt);
  });
});
