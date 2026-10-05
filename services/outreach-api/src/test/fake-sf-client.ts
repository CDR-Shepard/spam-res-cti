/** A scripted stand-in for SalesforceClient for research tests: describes from a table, SOQL and REST matched by regex. */
import type { SalesforceClient, SalesforceResponse, SObjectDescribe } from '@cti/salesforce';

type Row = Record<string, unknown>;
export type QueryRoute = [RegExp, Row[] | Error | ((soql: string) => Row[])];
export type RequestRoute = [RegExp, SalesforceResponse | Error];

export interface FakeSf {
  client: SalesforceClient;
  /** Every SOQL string sent, in order. */
  soql: string[];
  /** Every sobject described, in order. */
  described: string[];
  /** Every REST path requested, in order. */
  paths: string[];
}

export function fakeSalesforce(opts: {
  describes?: Record<string, SObjectDescribe>;
  queries?: QueryRoute[];
  requests?: RequestRoute[];
}): FakeSf {
  const soql: string[] = [];
  const described: string[] = [];
  const paths: string[] = [];
  const client = {
    async describe(name: string): Promise<SObjectDescribe> {
      described.push(name);
      const d = opts.describes?.[name];
      if (!d) throw new Error(`fakeSalesforce: no describe for ${name}`);
      return d;
    },
    async query(q: string): Promise<Row[]> {
      soql.push(q);
      const route = (opts.queries ?? []).find(([re]) => re.test(q));
      if (!route) throw new Error(`fakeSalesforce: no query route for ${q}`);
      const [, answer] = route;
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(q) : answer;
    },
    async request(path: string): Promise<SalesforceResponse> {
      paths.push(path);
      const route = (opts.requests ?? []).find(([re]) => re.test(path));
      if (!route) throw new Error(`fakeSalesforce: no request route for ${path}`);
      const [, answer] = route;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as SalesforceClient;
  return { client, soql, described, paths };
}

export const describeOf = (name: string, fields: Array<[string, string?]>): SObjectDescribe => ({
  name,
  fields: fields.map(([n, type = 'string']) => ({ name: n, type, label: `${n} label` })),
});
