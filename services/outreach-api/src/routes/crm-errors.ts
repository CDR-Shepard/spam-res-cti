import type { FastifyReply } from 'fastify';
import { SalesforceApiError, SalesforceAuthError } from '@cti/salesforce';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { salesforceErrorText } from '../crm/salesforce-error.js';
import { sendError } from '../http/errors.js';

export const CRM_NOT_CONNECTED_MESSAGE = 'Connect Salesforce in Settings → Connections first';

/** Answers the Salesforce failures every CRM-backed route shares; anything else is rethrown to the 500 handler. */
export function sendCrmError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CrmNotConnectedError || err instanceof SalesforceAuthError) {
    return sendError(reply, 409, 'CRM_NOT_CONNECTED', CRM_NOT_CONNECTED_MESSAGE);
  }
  if (err instanceof SalesforceApiError) {
    return sendError(reply, 502, 'SALESFORCE_ERROR', `Salesforce answered: ${salesforceErrorText(err)}`);
  }
  throw err;
}
