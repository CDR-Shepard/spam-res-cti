/**
 * Salesforce REST client behind an injectable token source.
 *
 * Modeled on services/cti-api/src/salesforce/client.ts (`sfFetch`,
 * `soqlQuery`), with three differences: the token comes from a `TokenSource`
 * (per-rep or company-wide, the caller decides), HTTP goes through `fetchImpl`
 * (global `fetch` by default, a fake in tests), and `queryAll` follows
 * `nextRecordsUrl` to the end instead of stopping at the first page.
 */
import { toDescribe, type SObjectDescribe } from './describe-parse.js';
import { QueryTooLargeError, SalesforceApiError, SalesforceAuthError } from './errors.js';
import { parseListViews, type ListViewSummary } from './listviews.js';
import { soapFault, xmlEscape } from './xml.js';

export type { PicklistValue, RecordTypeInfo, SObjectDescribe, SObjectField } from './describe-parse.js';

export interface SalesforceToken {
  accessToken: string;
  instanceUrl: string;
}

export interface TokenSource {
  /** The stored token; throws `SalesforceAuthError` when there is no connection. */
  current(): Promise<SalesforceToken>;
  /** Exchanges the refresh token for a new access token and persists it. */
  refresh(): Promise<SalesforceToken>;
}

export interface SalesforceClientOptions {
  tokens: TokenSource;
  /** e.g. `v60.0`. */
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

export interface CompositeResult {
  id?: string;
  success: boolean;
  errors: Array<{ statusCode: string; message: string; fields?: string[] }>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface SalesforceRequestInit {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SalesforceResponse {
  status: number;
  json: unknown;
}

export interface SoapResponse {
  status: number;
  xml: string;
}

/** sObject Collections takes at most 200 records per request (a Salesforce limit). */
export const COMPOSITE_BATCH_LIMIT = 200;
/** The campaign size cap; `queryAll`'s default `maxRecords`. */
export const DEFAULT_MAX_RECORDS = 50_000;
/** Every Salesforce request, including the token POST, gives up after this long. */
export const SALESFORCE_REQUEST_TIMEOUT_MS = 30_000;
/** List views come back in pages; more than this many pages is treated as the end. */
const MAX_LIST_VIEW_PAGES = 20;

interface QueryPage<T> {
  records: T[];
  totalSize: number | null;
  nextRecordsUrl: string | null;
}

export class SalesforceClient {
  private readonly tokens: TokenSource;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SalesforceClientOptions) {
    this.tokens = opts.tokens;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /**
   * One REST call against `/services/data/{apiVersion}{path}`. A 401 refreshes
   * the token once and retries; a second 401 throws `SalesforceAuthError`.
   * Any other status is returned for the caller to judge.
   */
  async request(path: string, init: SalesforceRequestInit = {}): Promise<SalesforceResponse> {
    return this.send((instanceUrl) => this.apiUrl(instanceUrl, path, init.query), init);
  }

  /** First page of a SOQL query only. */
  async query<T = Record<string, unknown>>(soql: string, opts: { signal?: AbortSignal } = {}): Promise<T[]> {
    const page = await this.queryPage<T>((instanceUrl) => this.apiUrl(instanceUrl, '/query', { q: soql }), opts.signal);
    return page.records;
  }

  /**
   * Every row of a SOQL query, following `nextRecordsUrl` to the end. Uses the
   * REST `query` resource, not `queryAll` (which would add deleted rows).
   * Throws `QueryTooLargeError` as soon as the result is known to exceed
   * `maxRecords` (default 50,000).
   */
  async queryAll<T = Record<string, unknown>>(
    soql: string,
    opts: { maxRecords?: number; signal?: AbortSignal } = {},
  ): Promise<T[]> {
    const max = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
    let page = await this.queryPage<T>((instanceUrl) => this.apiUrl(instanceUrl, '/query', { q: soql }), opts.signal);
    if (page.totalSize !== null && page.totalSize > max) throw new QueryTooLargeError(max);
    let records = page.records;
    while (page.nextRecordsUrl !== null) {
      if (records.length > max) throw new QueryTooLargeError(max);
      const next = this.dataPath(page.nextRecordsUrl);
      page = await this.queryPage<T>((instanceUrl) => new URL(next, instanceUrl), opts.signal);
      records = records.concat(page.records);
    }
    if (records.length > max) throw new QueryTooLargeError(max);
    return records;
  }

  async describe(sobject: string): Promise<SObjectDescribe> {
    const res = await this.request(`/sobjects/${encodeURIComponent(sobject)}/describe`);
    if (res.status >= 400) throw apiError(`Describe ${sobject} failed`, res);
    return toDescribe(res.json, sobject);
  }

  async listViews(sobject: 'Lead' | 'Opportunity'): Promise<ListViewSummary[]> {
    let res = await this.request(`/sobjects/${sobject}/listviews`);
    let all: unknown[] = [];
    for (let page = 1; ; page += 1) {
      if (res.status >= 400) throw apiError(`List views for ${sobject} failed`, res);
      const body = (res.json ?? {}) as { listviews?: unknown; nextRecordsUrl?: unknown };
      all = all.concat(Array.isArray(body.listviews) ? body.listviews : []);
      const next = typeof body.nextRecordsUrl === 'string' && body.nextRecordsUrl ? body.nextRecordsUrl : null;
      if (next === null || page >= MAX_LIST_VIEW_PAGES) break;
      const path = this.dataPath(next);
      res = await this.send((instanceUrl) => new URL(path, instanceUrl), {});
    }
    return parseListViews({ listviews: all });
  }

  /** The SOQL behind a list view: `GET /sobjects/{o}/listviews/{id}/describe` → `.query`. */
  async listViewSoql(sobject: 'Lead' | 'Opportunity', listViewId: string): Promise<string> {
    const res = await this.request(`/sobjects/${sobject}/listviews/${encodeURIComponent(listViewId)}/describe`);
    if (res.status >= 400) throw apiError(`List view ${listViewId} describe failed`, res);
    const query = (res.json as { query?: unknown } | null)?.query;
    if (typeof query !== 'string' || query.trim() === '') {
      throw new SalesforceApiError(`List view ${listViewId} describe returned no query`, res.status, res.json);
    }
    return query;
  }

  /** `POST /composite/sobjects` with `allOrNone: false`; results align with `records` by index. */
  async createRecords(
    records: Array<{ sobject: string; fields: Record<string, unknown> }>,
  ): Promise<CompositeResult[]> {
    return this.collections(
      'POST',
      records.map((r) => ({ ...r.fields, attributes: { type: r.sobject } })),
    );
  }

  /** `PATCH /composite/sobjects` with `allOrNone: false`; results align with `records` by index. */
  async updateRecords(
    records: Array<{ sobject: string; id: string; fields: Record<string, unknown> }>,
  ): Promise<CompositeResult[]> {
    return this.collections(
      'PATCH',
      records.map((r) => ({ ...r.fields, attributes: { type: r.sobject }, id: r.id })),
    );
  }

  private async collections(method: 'POST' | 'PATCH', payload: Array<Record<string, unknown>>): Promise<CompositeResult[]> {
    if (payload.length === 0) return [];
    if (payload.length > COMPOSITE_BATCH_LIMIT) {
      throw new RangeError(`At most ${COMPOSITE_BATCH_LIMIT} records per request (got ${payload.length})`);
    }
    const res = await this.request('/composite/sobjects', { method, body: { allOrNone: false, records: payload } });
    if (res.status < 200 || res.status >= 300) throw apiError(`Composite ${method} failed`, res);
    if (!Array.isArray(res.json) || res.json.length !== payload.length) {
      throw new SalesforceApiError(
        `Composite ${method} returned a body that does not align with ${payload.length} records`,
        res.status,
        res.json,
      );
    }
    return res.json.map(toCompositeResult);
  }

  /**
   * POST a SOAP envelope to /services/Soap/u/{n} (n = apiVersion without the 'v'). `bodyXml` goes inside
   * <env:Body>; the SessionHeader carries the current access token (the connection's `api` scope covers SOAP).
   * A fault `INVALID_SESSION_ID` (or HTTP 401) refreshes the token once and retries; a second one throws
   * SalesforceAuthError. Other faults are returned for the caller to read. 30 s timeout, like every request.
   */
  async soap(bodyXml: string, opts: { signal?: AbortSignal } = {}): Promise<SoapResponse> {
    const first = await this.soapOnce(await this.tokens.current(), bodyXml, opts.signal);
    if (!sessionRefused(first)) return first;
    const second = await this.soapOnce(await this.tokens.refresh(), bodyXml, opts.signal);
    if (sessionRefused(second)) throw new SalesforceAuthError('Salesforce rejected the refreshed access token (SOAP INVALID_SESSION_ID)');
    return second;
  }

  private async soapOnce(token: SalesforceToken, bodyXml: string, signal?: AbortSignal): Promise<SoapResponse> {
    const url = new URL(`/services/Soap/u/${this.apiVersion.replace(/^v/, '')}`, token.instanceUrl);
    const envelope =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">' +
      `<env:Header><urn:SessionHeader><urn:sessionId>${xmlEscape(token.accessToken)}</urn:sessionId></urn:SessionHeader></env:Header>` +
      `<env:Body>${bodyXml}</env:Body></env:Envelope>`;
    const timeout = AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=UTF-8', accept: 'text/xml', SOAPAction: '""' },
        body: envelope,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return { status: res.status, xml: await res.text() };
    } catch (err) {
      throw new SalesforceApiError(`Salesforce SOAP request failed: ${errorText(err)}`, 0, null);
    }
  }

  private async queryPage<T>(urlFor: (instanceUrl: string) => URL, signal?: AbortSignal): Promise<QueryPage<T>> {
    const res = await this.send(urlFor, { signal });
    if (res.status >= 400) throw apiError('SOQL failed', res);
    const body = (res.json ?? {}) as { records?: unknown; totalSize?: unknown; nextRecordsUrl?: unknown };
    return {
      records: Array.isArray(body.records) ? (body.records as T[]) : [],
      totalSize: typeof body.totalSize === 'number' ? body.totalSize : null,
      nextRecordsUrl: typeof body.nextRecordsUrl === 'string' && body.nextRecordsUrl ? body.nextRecordsUrl : null,
    };
  }

  /** A follow-up path Salesforce handed back. Only same-instance data paths are
   *  followed, so a bearer token is never sent to another host. */
  private dataPath(next: string): string {
    if (!next.startsWith('/services/data/')) {
      throw new SalesforceApiError(`Refusing to follow a next-page URL outside /services/data/: ${next}`, 200, null);
    }
    return next;
  }

  private apiUrl(instanceUrl: string, path: string, query?: Record<string, string>): URL {
    const url = new URL(`/services/data/${this.apiVersion}${path}`, instanceUrl);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async send(urlFor: (instanceUrl: string) => URL, init: SalesforceRequestInit): Promise<SalesforceResponse> {
    const token = await this.tokens.current();
    const first = await this.once(urlFor(token.instanceUrl), token.accessToken, init);
    if (first.status !== 401) return first;
    const refreshed = await this.tokens.refresh();
    const second = await this.once(urlFor(refreshed.instanceUrl), refreshed.accessToken, init);
    if (second.status === 401) throw new SalesforceAuthError('Salesforce rejected the refreshed access token (401)');
    return second;
  }

  private async once(url: URL, accessToken: string, init: SalesforceRequestInit): Promise<SalesforceResponse> {
    const timeout = AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      return { status: res.status, json: parseBody(await res.text()) };
    } catch (err) {
      // A network failure or timeout is transient, never a broken connection.
      throw new SalesforceApiError(`Salesforce request failed: ${errorText(err)}`, 0, null);
    }
  }
}

function sessionRefused(res: SoapResponse): boolean {
  return res.status === 401 || soapFault(res.xml)?.code === 'INVALID_SESSION_ID';
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function apiError(what: string, res: SalesforceResponse): SalesforceApiError {
  return new SalesforceApiError(`${what} (${res.status}): ${JSON.stringify(res.json)}`, res.status, res.json);
}

function toCompositeResult(raw: unknown): CompositeResult {
  const r = (raw ?? {}) as { id?: unknown; success?: unknown; errors?: unknown };
  return {
    ...(typeof r.id === 'string' && r.id ? { id: r.id } : {}),
    success: r.success === true,
    errors: Array.isArray(r.errors) ? r.errors.map(toCompositeError) : [],
  };
}

function toCompositeError(raw: unknown): CompositeResult['errors'][number] {
  const e = (raw ?? {}) as { statusCode?: unknown; message?: unknown; fields?: unknown };
  return {
    statusCode: typeof e.statusCode === 'string' && e.statusCode ? e.statusCode : 'UNKNOWN_ERROR',
    message: typeof e.message === 'string' ? e.message : '',
    ...(Array.isArray(e.fields) ? { fields: e.fields.filter((x): x is string => typeof x === 'string') } : {}),
  };
}
