import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAppVersion, outreachKeys } from './outreach-api';
import { respond, stubApi } from '../test/stub-api';

afterEach(() => vi.unstubAllGlobals());

const ROUTE = 'GET /api/version';
const app = { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' };

describe('getAppVersion', () => {
  it('sends GET /api/version and returns the parsed body', async () => {
    const body = { app, calls: { commit: '1234567' } };
    const calls = stubApi({ [ROUTE]: body });
    expect(await getAppVersion()).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(ROUTE);
  });

  it('keeps calls: null (the AI voice server could not be reached)', async () => {
    stubApi({ [ROUTE]: { app, calls: null } });
    expect(await getAppVersion()).toEqual({ app, calls: null });
  });

  it('rejects a body that does not match the contract', async () => {
    stubApi({ [ROUTE]: { app: { commit: '8a398bc' }, calls: null } });
    await expect(getAppVersion()).rejects.toThrow();
  });

  it('surfaces an error response', async () => {
    stubApi({ [ROUTE]: respond(401, { error: 'Sign in required', code: 'UNAUTHENTICATED' }) });
    await expect(getAppVersion()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('has its own query key', () => {
    expect(outreachKeys.appVersion).toEqual(['app', 'version']);
  });
});
