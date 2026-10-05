import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { loggableUrl } from './log-serializers.js';

describe('loggableUrl', () => {
  it('drops the query string (code, state) from OAuth callbacks', () => {
    expect(loggableUrl('/api/connections/salesforce/callback?code=abc&state=xyz')).toBe('/api/connections/salesforce/callback');
    expect(loggableUrl('/api/auth/workos/callback?code=abc&state=xyz')).toBe('/api/auth/workos/callback');
  });

  it('leaves every other URL, and callbacks without a query, as they are', () => {
    expect(loggableUrl('/api/campaigns?status=active&limit=5')).toBe('/api/campaigns?status=active&limit=5');
    expect(loggableUrl('/api/connections/salesforce/callback')).toBe('/api/connections/salesforce/callback');
    expect(loggableUrl('/health')).toBe('/health');
  });
});

describe('request logging', () => {
  it('never writes an OAuth callback code or state to the log, but still logs the request', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      cfg: testConfig({ NODE_ENV: 'development' }),
      readiness: async () => ({ ok: true, checks: {} }) as never,
      logStream: { write: (line) => lines.push(line) },
      apiRoutes: [async (scope) => { scope.get('/connections/salesforce/callback', async () => ({ ok: true })); }],
    });
    await app.inject({ method: 'GET', url: '/api/connections/salesforce/callback?code=SECRETCODE&state=SECRETSTATE' });
    await app.inject({ method: 'GET', url: '/api/connections/salesforce/callback?code=SECRETCODE2&state=SECRETSTATE2' });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('/api/connections/salesforce/callback');
    expect(log).not.toMatch(/SECRET/);
  });
});
