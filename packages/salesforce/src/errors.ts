/** No usable connection: none stored, the refresh failed, or Salesforce
 *  answered 401 again right after a refresh. The caller should mark the
 *  connection broken; retrying will not help. */
export class SalesforceAuthError extends Error {
  constructor(message = 'Salesforce connection missing or revoked') {
    super(message);
    this.name = 'SalesforceAuthError';
  }
}

/** Salesforce answered, but with an error (≥ 400) or a body we could not use.
 *  `body` is Salesforce's parsed answer, kept so callers can show it verbatim. */
export class SalesforceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

/** A query matched more than `limit` records. */
export class QueryTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Query returned more than ${limit} records; narrow the query`);
    this.name = 'QueryTooLargeError';
  }
}
