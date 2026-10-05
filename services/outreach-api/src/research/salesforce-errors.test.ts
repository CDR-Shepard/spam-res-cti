import { describe, expect, it } from 'vitest';
import { SalesforceApiError, SalesforceAuthError } from '@cti/salesforce';
import { classifyReadError, readSource } from './salesforce-errors.js';

const sfErr = (status: number, errorCode: string) => new SalesforceApiError(`SOQL failed (${status})`, status, [{ errorCode, message: 'x' }]);

describe('classifyReadError', () => {
  it.each([
    [sfErr(400, 'INVALID_TYPE'), 'missing'],
    [sfErr(400, 'INVALID_FIELD'), 'missing'],
    [sfErr(400, 'MALFORMED_QUERY'), 'missing'],
    [sfErr(403, 'INSUFFICIENT_ACCESS'), 'denied'],
    [sfErr(400, 'FUNCTIONALITY_NOT_ENABLED'), 'denied'],
    [sfErr(403, 'API_DISABLED_FOR_ORG'), 'denied'],
    [sfErr(400, 'SOMETHING_NEW'), 'error'],
  ])('%s → %s', (err, status) => {
    expect(classifyReadError(err).status).toBe(status);
  });
  it('rethrows outages, timeouts and auth failures: the whole research is retried later', () => {
    expect(() => classifyReadError(new SalesforceApiError('down', 503, null))).toThrow('down');
    expect(() => classifyReadError(new SalesforceApiError('timeout', 0, null))).toThrow('timeout');
    expect(() => classifyReadError(new SalesforceAuthError())).toThrow();
    expect(() => classifyReadError(new Error('bug'))).toThrow('bug');
  });
  it('rethrows throttling: a rate limit is not a missing or denied source', () => {
    expect(() => classifyReadError(sfErr(403, 'REQUEST_LIMIT_EXCEEDED'))).toThrow();
    expect(() => classifyReadError(sfErr(400, 'QUERY_TIMEOUT'))).toThrow();
    expect(() => classifyReadError(new SalesforceApiError('slow down', 429, null))).toThrow('slow down');
  });
});

describe('readSource', () => {
  it('reports ok with the count, or the degraded status with an empty list', async () => {
    expect(await readSource('tasks', async () => ({ items: [1, 2], truncated: true }))).toEqual({
      items: [1, 2],
      summary: { source: 'tasks', status: 'ok', count: 2, truncated: true, note: null },
    });
    expect(await readSource('chatter', async () => { throw sfErr(400, 'INVALID_TYPE'); })).toEqual({
      items: [],
      summary: { source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' },
    });
  });
});
