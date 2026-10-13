import { describe, expect, it } from 'vitest';
import { AppVersion, CtiBuildHealth, DEV_COMMIT, shortCommit } from './version.js';

const FULL_SHA = '8a398bc1f0e2d4c6b8a7e9f01234567890abcdef';

describe('shortCommit', () => {
  it('keeps the first 7 characters of a full commit sha', () => {
    expect(shortCommit(FULL_SHA)).toBe('8a398bc');
  });

  it('lower-cases and trims what the platform hands over', () => {
    expect(shortCommit(`  ${FULL_SHA.toUpperCase()}\n`)).toBe('8a398bc');
  });

  it('keeps an already-short 7 character sha', () => {
    expect(shortCommit('8a398bc')).toBe('8a398bc');
  });

  it.each([undefined, null, '', '   '])('%j is "dev" (no commit known)', (value) => {
    expect(shortCommit(value)).toBe(DEV_COMMIT);
    expect(DEV_COMMIT).toBe('dev');
  });

  it.each(['dev', 'abc12', 'not-a-commit-sha', 'zzzzzzzz', `${FULL_SHA}0`])('%s is not a commit sha, so it is "dev" (never echoed back)', (value) => {
    expect(shortCommit(value)).toBe(DEV_COMMIT);
  });
});

describe('AppVersion', () => {
  const app = { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' };

  it('parses the live app commit and start time with the calls commit', () => {
    const body = { app, calls: { commit: '8a398bc' } };
    expect(AppVersion.parse(body)).toEqual(body);
  });

  it('parses calls: null (the AI voice server could not be reached)', () => {
    expect(AppVersion.parse({ app, calls: null })).toEqual({ app, calls: null });
  });

  it.each([
    ['no calls key', { app }],
    ['an app without a start time', { app: { commit: '8a398bc' }, calls: null }],
    ['a start time that is not a date', { app: { ...app, startedAt: 'yesterday' }, calls: null }],
    ['a non-string commit', { app: { ...app, commit: 8 }, calls: null }],
  ])('rejects %s', (_label, body) => {
    expect(AppVersion.safeParse(body).success).toBe(false);
  });

  it('strips fields it does not name, so nothing else can ride along', () => {
    const parsed = AppVersion.parse({ app: { ...app, secret: 'x' }, calls: { commit: '8a398bc', token: 'y' }, extra: 1 });
    expect(parsed).toEqual({ app, calls: { commit: '8a398bc' } });
  });
});

describe('CtiBuildHealth', () => {
  it('reads the commit out of cti-api /healthz and ignores the rest', () => {
    expect(CtiBuildHealth.parse({ ok: true, ts: '2026-10-13T21:41:00.000Z', commit: '8a398bc', startedAt: '2026-10-13T21:00:00.000Z' })).toEqual({ commit: '8a398bc' });
  });

  it('rejects a /healthz with no commit (an older deploy)', () => {
    expect(CtiBuildHealth.safeParse({ ok: true, ts: '2026-10-13T21:41:00.000Z' }).success).toBe(false);
  });
});
