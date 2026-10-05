import type { SalesforceApiError } from '@cti/salesforce';

/**
 * Salesforce's own words for a failed call (`INVALID_FIELD: No such column
 * 'Foo__c' on entity 'Lead'`), for the admin to read. REST errors arrive as
 * `[{ errorCode, message }]`; anything else falls back to the error message.
 */
export function salesforceErrorText(err: SalesforceApiError): string {
  const first: unknown = Array.isArray(err.body) ? err.body[0] : err.body;
  if (first && typeof first === 'object') {
    const { errorCode, message } = first as { errorCode?: unknown; message?: unknown };
    if (typeof message === 'string' && message) return typeof errorCode === 'string' && errorCode ? `${errorCode}: ${message}` : message;
  }
  return err.message;
}
