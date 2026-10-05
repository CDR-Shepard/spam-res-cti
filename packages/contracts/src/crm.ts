import { z } from 'zod';

/** The two Salesforce objects a campaign can target. */
export const SfObject = z.enum(['Lead', 'Opportunity']);
export type SfObject = z.infer<typeof SfObject>;

/** A way to reach a person. The planner maps `call` to `ai_call` or `rep_call`. */
export const ContactChannel = z.enum(['call', 'sms', 'email']);
export type ContactChannel = z.infer<typeof ContactChannel>;

/** Which Salesforce fields hold what, for one object. Field API names; null = not mapped. */
export const ObjectFieldMap = z.object({
  /** Text fields passed to triage, in order. */
  notes: z.array(z.string()).max(20),
  /** Phone fields in dialing order. */
  phones: z.array(z.string()).max(6),
  /** Null on Opportunity: the primary contact role's Contact.Email is used. */
  email: z.string().nullable(),
  doNotCall: z.string().nullable(),
  emailOptOut: z.string().nullable(),
  skipOnDialer: z.string().nullable(),
  consent: z.string().nullable(),
  webFormSource: z.string().nullable(),
  state: z.string().nullable(),
  leadManager: z.string().nullable(),
});
export type ObjectFieldMap = z.infer<typeof ObjectFieldMap>;

export const FieldMap = z.object({ Lead: ObjectFieldMap, Opportunity: ObjectFieldMap });
export type FieldMap = z.infer<typeof FieldMap>;

/** GET /api/connections/salesforce. */
export const CrmConnectionStatus = z.object({
  /** The server has its SALESFORCE_* settings; false = connecting is not possible. */
  configured: z.boolean(),
  connected: z.boolean(),
  status: z.enum(['connected', 'broken']).nullable(),
  instanceUrl: z.string().nullable(),
  username: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  fieldMap: FieldMap.nullable(),
});
export type CrmConnectionStatus = z.infer<typeof CrmConnectionStatus>;

/** POST /api/connections/salesforce/start: where to send the admin's browser. */
export const StartConnectionResponse = z.object({ url: z.string().url() });
export type StartConnectionResponse = z.infer<typeof StartConnectionResponse>;

/** GET /api/crm/listviews?object=Lead|Opportunity. */
export const ListViewsResponse = z.object({
  listViews: z.array(z.object({ id: z.string(), label: z.string(), developerName: z.string() })),
});
export type ListViewsResponse = z.infer<typeof ListViewsResponse>;
