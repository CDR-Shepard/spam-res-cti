import type { Db } from '@cti/db';
import { SalesforceAuthError, SalesforceClient, type SalesforceOAuthConfig, type SalesforceToken } from '@cti/salesforce';
import type { AppConfig } from '../config.js';
import { loadConnection, orgTokenSource } from './connection-store.js';

/** The tenant has no usable Salesforce connection (none, broken, or the server has no Salesforce config). Routes answer 409 CRM_NOT_CONNECTED. */
export class CrmNotConnectedError extends Error {
  constructor(message = 'Salesforce is not connected for this tenant') {
    super(message);
    this.name = 'CrmNotConnectedError';
  }
}

/** Builds a SalesforceClient on a tenant's company-wide connection. Injected into routes and jobs so tests pass a fake. */
export type SalesforceClientFactory = (orgId: string) => Promise<SalesforceClient>;

export function salesforceOAuthConfig(cfg: AppConfig): SalesforceOAuthConfig {
  if (!cfg.salesforceEnabled || !cfg.SALESFORCE_CLIENT_ID || !cfg.SALESFORCE_REDIRECT_URI) {
    throw new Error('Salesforce is not configured on this server');
  }
  return {
    clientId: cfg.SALESFORCE_CLIENT_ID,
    clientSecret: cfg.SALESFORCE_CLIENT_SECRET,
    redirectUri: cfg.SALESFORCE_REDIRECT_URI,
    loginUrl: cfg.SALESFORCE_LOGIN_URL,
  };
}

export function liveClientFactory(db: Db, cfg: AppConfig, fetchImpl?: typeof fetch): SalesforceClientFactory {
  return async (orgId) => {
    if (!cfg.salesforceEnabled) throw new CrmNotConnectedError('Salesforce is not configured on this server');
    const row = await loadConnection(db, orgId);
    if (!row || row.status !== 'connected') throw new CrmNotConnectedError();
    return new SalesforceClient({
      tokens: orgTokenSource(db, orgId, salesforceOAuthConfig(cfg), fetchImpl),
      apiVersion: cfg.SALESFORCE_API_VERSION,
      fetchImpl,
    });
  };
}

/**
 * A client on a token that is not stored yet: the OAuth callback describes
 * Lead and Opportunity with the token it just received, before saving. It
 * cannot refresh — a 401 here means the brand-new token is bad.
 */
export function bootstrapClient(token: SalesforceToken, cfg: AppConfig, fetchImpl?: typeof fetch): SalesforceClient {
  return new SalesforceClient({
    tokens: {
      current: async () => token,
      refresh: async () => {
        throw new SalesforceAuthError('Salesforce rejected the token it just issued');
      },
    },
    apiVersion: cfg.SALESFORCE_API_VERSION,
    fetchImpl,
  });
}
