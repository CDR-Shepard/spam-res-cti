/**
 * Adapts the Salesforce record lookup to the firewall's recipient-address port.
 * The firewall package has no CRM import; this is the only place the two meet.
 */
import { RecipientLookupUnauthorizedError, type FirewallDeps } from '@cti/firewall';
import { fetchRecordAddress, SalesforceUnauthorizedError } from '../salesforce/client.js';

export const fetchRecipientAddress: NonNullable<FirewallDeps['fetchRecipientAddress']> = async (userId, recordId) => {
  try {
    return await fetchRecordAddress(userId, recordId);
  } catch (err) {
    if (err instanceof SalesforceUnauthorizedError) throw new RecipientLookupUnauthorizedError();
    throw err;
  }
};

export const firewallDeps: FirewallDeps = { fetchRecipientAddress };
