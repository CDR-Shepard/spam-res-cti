/**
 * Thrown by a `FirewallDeps.fetchRecipientAddress` adapter when the hosting
 * service's CRM connection is missing or revoked. `evaluate` logs it as a
 * skipped lookup (not a failure) and continues with the area-code fallback.
 */
export class RecipientLookupUnauthorizedError extends Error {
  constructor() {
    super('Recipient address lookup not authorized');
    this.name = 'RecipientLookupUnauthorizedError';
  }
}
