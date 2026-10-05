/**
 * A scripted Salesforce login server for the sign-in tests (Tasks 0B and 0D): the token endpoint,
 * the userinfo endpoint and the revoke endpoint, switched on the request path. Plain function, no
 * vi.fn, so unit tests and route tests share it.
 */
export interface FakeSalesforceLoginOptions {
  orgId?: string;
  userId?: string;
  /** `null` is answered as JSON null, as an unset email may be. */
  email?: string | null;
  name?: string;
  /** Answer the token endpoint with this status (and `{ error: 'invalid_grant' }` for a 400). */
  tokenStatus?: number;
  /** How many userinfo reads answer 401 before one succeeds. */
  userinfoFailures?: number;
  /** The `organization_id` userinfo reports, when it should differ from the token's `id` URL. */
  userinfoOrgId?: string;
  /** The `user_id` userinfo reports, when it should differ from the token's `id` URL. */
  userinfoUserId?: string;
  /** Leave `refresh_token` out of the token response. */
  noRefreshToken?: boolean;
}

export interface FakeSalesforceLoginCall {
  url: string;
  method: string;
  body: string;
}

export const FAKE_SF_ORG_ID = '00D5e000000AbCdEAK';
export const FAKE_SF_USER_ID = '0055e000001XyZaAAK';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeSalesforceLogin(opts: FakeSalesforceLoginOptions = {}): { fetchImpl: typeof fetch; calls: FakeSalesforceLoginCall[] } {
  const orgId = opts.orgId ?? FAKE_SF_ORG_ID;
  const userId = opts.userId ?? FAKE_SF_USER_ID;
  const calls: FakeSalesforceLoginCall[] = [];
  let userinfoReads = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method: init?.method ?? 'GET', body });
    switch (new URL(url).pathname) {
      case '/services/oauth2/token':
        if (opts.tokenStatus && opts.tokenStatus !== 200) return json(opts.tokenStatus, { error: opts.tokenStatus === 400 ? 'invalid_grant' : 'server_error' });
        return json(200, {
          access_token: 'AT',
          ...(opts.noRefreshToken ? {} : { refresh_token: 'RT' }),
          instance_url: 'https://acme.my.salesforce.com',
          id: `https://login.salesforce.com/id/${orgId}/${userId}`,
        });
      case '/services/oauth2/userinfo':
        userinfoReads += 1;
        if (userinfoReads <= (opts.userinfoFailures ?? 0)) return json(401, { error: 'invalid_session' });
        return json(200, {
          user_id: opts.userinfoUserId ?? userId,
          organization_id: opts.userinfoOrgId ?? orgId,
          email: opts.email === undefined ? 'rep@gg.com' : opts.email,
          name: opts.name ?? 'Rae Rep',
        });
      case '/services/oauth2/revoke':
        return new Response(null, { status: 200 });
      default:
        return json(404, { error: 'not_found' });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}
