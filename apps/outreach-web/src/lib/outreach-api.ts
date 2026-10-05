import {
  AuthProviders,
  Campaign,
  CampaignPlanResponse,
  CampaignPreview,
  CampaignsResponse,
  CrmConnectionStatus,
  ListViewsResponse,
  NeedsReviewResponse,
  StartConnectionResponse,
  type CampaignStatusChange,
  type CreateCampaignRequest,
  type EnrollmentStatus,
  type FieldMap,
  type PreviewRequest,
  type ReviewDecision,
  type SfObject,
  type UpdateCampaignRequest,
} from '@cti/contracts';
import { api, apiEmpty, json } from './api';

/**
 * TanStack Query keys for outreach data. Pages read with these and mutations
 * invalidate with these, so the two can never drift apart.
 */
export const outreachKeys = {
  authProviders: ['auth', 'providers'] as const,
  connection: ['crm', 'connection'] as const,
  listViews: (sfObject: SfObject) => ['crm', 'listviews', sfObject] as const,
  campaignLists: ['campaigns', 'list'] as const,
  campaignList: (archived: boolean) => ['campaigns', 'list', archived] as const,
  campaign: (campaignId: string) => ['campaigns', 'detail', campaignId] as const,
  plans: ['campaigns', 'plan'] as const,
  plan: (campaignId: string) => ['campaigns', 'plan', campaignId] as const,
  review: ['review'] as const,
};

const seg = (value: string): string => encodeURIComponent(value);

/** Which sign-in buttons the server offers; needs no session. */
export function getAuthProviders(): Promise<AuthProviders> {
  return api('/api/auth/providers', AuthProviders);
}

export function getConnection(): Promise<CrmConnectionStatus> {
  return api('/api/connections/salesforce', CrmConnectionStatus);
}

export function startConnection(): Promise<StartConnectionResponse> {
  return api('/api/connections/salesforce/start', StartConnectionResponse, { method: 'POST' });
}

/** The route's success body is not part of the contract; the page refetches `getConnection()` after saving. */
export function saveFieldMap(fieldMap: FieldMap): Promise<void> {
  return apiEmpty('/api/connections/salesforce/field-map', { method: 'PUT', body: json(fieldMap) });
}

export function disconnect(): Promise<void> {
  return apiEmpty('/api/connections/salesforce', { method: 'DELETE' });
}

export function listViews(sfObject: SfObject): Promise<ListViewsResponse> {
  return api(`/api/crm/listviews?object=${seg(sfObject)}`, ListViewsResponse);
}

export function previewCampaign(req: PreviewRequest): Promise<CampaignPreview> {
  return api('/api/campaigns/preview', CampaignPreview, { method: 'POST', body: json(req) });
}

export function listCampaigns(opts: { archived?: boolean } = {}): Promise<CampaignsResponse> {
  return api(`/api/campaigns${opts.archived ? '?archived=1' : ''}`, CampaignsResponse);
}

export function createCampaign(req: CreateCampaignRequest): Promise<Campaign> {
  return api('/api/campaigns', Campaign, { method: 'POST', body: json(req) });
}

export function getCampaign(campaignId: string): Promise<Campaign> {
  return api(`/api/campaigns/${seg(campaignId)}`, Campaign);
}

export function updateCampaign(campaignId: string, req: UpdateCampaignRequest): Promise<Campaign> {
  return api(`/api/campaigns/${seg(campaignId)}`, Campaign, { method: 'PATCH', body: json(req) });
}

export function changeCampaignStatus(campaignId: string, status: CampaignStatusChange['status']): Promise<Campaign> {
  const body: CampaignStatusChange = { status };
  return api(`/api/campaigns/${seg(campaignId)}/status`, Campaign, { method: 'POST', body: json(body) });
}

export function getPlan(campaignId: string, opts: { cursor?: string | null; status?: EnrollmentStatus } = {}): Promise<CampaignPlanResponse> {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.status) query.set('status', opts.status);
  const qs = query.toString();
  return api(`/api/campaigns/${seg(campaignId)}/plan${qs ? `?${qs}` : ''}`, CampaignPlanResponse);
}

export function getReview(): Promise<NeedsReviewResponse> {
  return api('/api/review', NeedsReviewResponse);
}

/** The route's success body is not part of the contract; the page drops the decided row itself. */
export function decideReview(enrollmentId: string, decision: ReviewDecision['decision']): Promise<void> {
  const body: ReviewDecision = { decision };
  return apiEmpty(`/api/review/${seg(enrollmentId)}`, { method: 'POST', body: json(body) });
}
