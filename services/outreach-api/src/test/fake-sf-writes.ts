/**
 * Plan 1D write-back tests: a scripted stand-in for SalesforceClient that also writes. Describes come from a table; SOQL is
 * answered by the first matching route (a function may read the fake's own state, so a test can model "the Event exists once
 * created"); every create, update and SOAP body is recorded in order, and each answer can be scripted per record.
 */
import type { CompositeResult, SalesforceClient, SObjectDescribe, SoapResponse } from '@cti/salesforce';

type Row = Record<string, unknown>;
export type WriteQueryRoute = [RegExp, Row[] | Error | ((soql: string) => Row[] | Error)];
export interface CreateCall {
  sobject: string;
  fields: Record<string, unknown>;
}
export interface UpdateCall extends CreateCall {
  id: string;
}
/** What one record of a create or update answers: a result, or an Error thrown for the whole request. */
export type WriteAnswer = CompositeResult | Error | undefined;

export interface FakeSfWrites {
  client: SalesforceClient;
  soql: string[];
  described: string[];
  creates: CreateCall[];
  updates: UpdateCall[];
  soapBodies: string[];
  /** Every Salesforce call, in order, as "query", "describe", "create <sobject>", "update <sobject>" or "soap". */
  log: string[];
  queries: WriteQueryRoute[];
  /** Per created record; `undefined` (or no hook) succeeds with a new id. */
  onCreate: ((c: CreateCall) => WriteAnswer) | null;
  onUpdate: ((u: UpdateCall) => WriteAnswer) | null;
  onSoap: ((body: string) => SoapResponse | Error) | null;
  describes: Record<string, SObjectDescribe>;
}

const PREFIX: Readonly<Record<string, string>> = { Event: '00U', Task: '00T', FeedItem: '0D5', Opportunity: '006', Contact: '003', Lead: '00Q' };
let counter = 0;
/** A fresh 18-character id for `sobject`. */
export function newSfId(sobject: string): string {
  counter += 1;
  return `${PREFIX[sobject] ?? '001'}8X${String(counter).padStart(10, '0')}AAA`;
}

export const ok = (id?: string): CompositeResult => ({ ...(id ? { id } : {}), success: true, errors: [] });
export const refused = (statusCode: string, message = 'refused', fields?: string[]): CompositeResult => ({
  success: false,
  errors: [{ statusCode, message, ...(fields ? { fields } : {}) }],
});

export function fakeSfWrites(opts: { describes?: Record<string, SObjectDescribe>; queries?: WriteQueryRoute[] } = {}): FakeSfWrites {
  const f: FakeSfWrites = {
    client: null as unknown as SalesforceClient,
    soql: [],
    described: [],
    creates: [],
    updates: [],
    soapBodies: [],
    log: [],
    queries: [...(opts.queries ?? [])],
    onCreate: null,
    onUpdate: null,
    onSoap: null,
    describes: { ...(opts.describes ?? {}) },
  };
  const answer = (q: string): Row[] => {
    f.soql.push(q);
    f.log.push('query');
    const route = f.queries.find(([re]) => re.test(q));
    if (!route) throw new Error(`fakeSfWrites: no query route for ${q}`);
    const out = typeof route[1] === 'function' ? route[1](q) : route[1];
    if (out instanceof Error) throw out;
    return out;
  };
  const results = (calls: CreateCall[], hook: ((c: never) => WriteAnswer) | null, isCreate: boolean): CompositeResult[] =>
    calls.map((c) => {
      const a = hook ? (hook as (c: CreateCall) => WriteAnswer)(c) : undefined;
      if (a instanceof Error) throw a;
      return a ?? ok(isCreate ? newSfId(c.sobject) : (c as UpdateCall).id);
    });
  f.client = {
    async describe(name: string): Promise<SObjectDescribe> {
      f.described.push(name);
      f.log.push('describe');
      const d = f.describes[name];
      if (!d) throw new Error(`fakeSfWrites: no describe for ${name}`);
      return d;
    },
    async query(q: string): Promise<Row[]> {
      return answer(q);
    },
    async queryAll(q: string): Promise<Row[]> {
      return answer(q);
    },
    async createRecords(records: CreateCall[]): Promise<CompositeResult[]> {
      const calls = records.map((r) => ({ sobject: r.sobject, fields: { ...r.fields } }));
      f.creates.push(...calls);
      f.log.push(...calls.map((c) => `create ${c.sobject}`));
      return results(calls, f.onCreate, true);
    },
    async updateRecords(records: UpdateCall[]): Promise<CompositeResult[]> {
      const calls = records.map((r) => ({ sobject: r.sobject, id: r.id, fields: { ...r.fields } }));
      f.updates.push(...calls);
      f.log.push(...calls.map((c) => `update ${c.sobject}`));
      return results(calls, f.onUpdate, false);
    },
    async soap(body: string): Promise<SoapResponse> {
      f.soapBodies.push(body);
      f.log.push('soap');
      if (!f.onSoap) throw new Error('fakeSfWrites: no SOAP answer scripted');
      const a = f.onSoap(body);
      if (a instanceof Error) throw a;
      return a;
    },
  } as unknown as SalesforceClient;
  return f;
}

const soapEnvelope = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="urn:partner.soap.sforce.com" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

/** A convertLead success answer. */
export const convertOk = (ids: { leadId: string; accountId: string; contactId: string; opportunityId: string }): SoapResponse => ({
  status: 200,
  xml: soapEnvelope(
    `<convertLeadResponse><result><accountId>${ids.accountId}</accountId><contactId>${ids.contactId}</contactId><leadId>${ids.leadId}</leadId><opportunityId>${ids.opportunityId}</opportunityId><success>true</success></result></convertLeadResponse>`,
  ),
});

/** A convertLead refusal (`success: false`). */
export const convertRefused = (statusCode: string, message: string): SoapResponse => ({
  status: 200,
  xml: soapEnvelope(`<convertLeadResponse><result><errors><message>${message}</message><statusCode>${statusCode}</statusCode></errors><success>false</success></result></convertLeadResponse>`),
});

/** A SOAP fault (HTTP 500). */
export const soapFaultAnswer = (code: string, message = code): SoapResponse => ({
  status: 500,
  xml: soapEnvelope(`<soapenv:Fault><faultcode>sf:${code}</faultcode><faultstring>${message}</faultstring></soapenv:Fault>`),
});

/** A getUserInfo answer for `userId`. */
export const userInfoAnswer = (userId: string): SoapResponse => ({
  status: 200,
  xml: soapEnvelope(`<getUserInfoResponse><result><organizationId>00D8X000000GgHmUAK</organizationId><userId>${userId}</userId><userName>integration@gghomes.com</userName></result></getUserInfoResponse>`),
});
