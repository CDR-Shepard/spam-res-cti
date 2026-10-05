import { describe, expect, it } from 'vitest';
import { SalesforceApiError } from '@cti/salesforce';
import { salesforceErrorText } from './salesforce-error.js';

describe('salesforceErrorText', () => {
  it.each([
    ['REST error array', [{ errorCode: 'INVALID_FIELD', message: "No such column 'Foo__c' on entity 'Lead'" }], "INVALID_FIELD: No such column 'Foo__c' on entity 'Lead'"],
    ['message without a code', [{ message: 'Bad thing' }], 'Bad thing'],
    ['single object', { errorCode: 'MALFORMED_QUERY', message: 'unexpected token' }, 'MALFORMED_QUERY: unexpected token'],
    ['unparseable body', 'oops', 'query failed (400)'],
  ])('%s', (_label, body, expected) => {
    expect(salesforceErrorText(new SalesforceApiError('query failed (400)', 400, body))).toBe(expected);
  });
});
