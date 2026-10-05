import {
  AiAvailability,
  AiCallResultsResponse,
  AiCallTranscript,
  AuthProviders,
  Campaign,
  CandidatePage,
  CampaignPlanResponse,
  CampaignPreview,
  CallPlanCard,
  CallPlansResponse,
  CampaignsResponse,
  ReleaseCallsResponse,
  CrmConnectionStatus,
  ListViewsResponse,
  NeedsReviewResponse,
  SelectionResponse,
  StartConnectionResponse,
  TestCallResponse,
  type CallStage,
  type CampaignStatusChange,
  type EditCallPlanRequest,
  type CreateCampaignInput,
  type EnrollmentStatus,
  type FieldMap,
  type PreviewRequest,
  type ReviewDecision,
  type SelectionChange,
  type SfObject,
  type TestCallRequest,
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
  candidateLists: (campaignId: string) => ['campaigns', 'candidates', campaignId] as const,
  candidates: (campaignId: string, page: number) => ['campaigns', 'candidates', campaignId, page] as const,
  callPlanLists: (campaignId: string) => ['campaigns', 'call-plans', campaignId] as const,
  callPlans: (campaignId: string, stage: CallStage | null) => ['campaigns', 'call-plans', campaignId, stage ?? 'all'] as const,
  review: ['review'] as const,
  aiCallResults: (campaignId: string) => ['campaigns', 'ai-calls', campaignId] as const,
  aiCallTranscript: (aiCallId: string) => ['ai-calls', 'transcript', aiCallId] as const,
  aiAvailability: ['ai-calls', 'availability'] as const,
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

export function createCampaign(req: CreateCampaignInput): Promise<Campaign> {
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

export function getCandidates(campaignId: string, page: number): Promise<CandidatePage> {
  return api(`/api/campaigns/${seg(campaignId)}/candidates?page=${page}`, CandidatePage);
}

export function changeSelection(campaignId: string, change: Partial<SelectionChange>): Promise<SelectionResponse> {
  return api(`/api/campaigns/${seg(campaignId)}/selection`, SelectionResponse, { method: 'PUT', body: json(change) });
}

export function getReview(): Promise<NeedsReviewResponse> {
  return api('/api/review', NeedsReviewResponse);
}

/** The route's success body is not part of the contract; the page drops the decided row itself. */
export function decideReview(enrollmentId: string, decision: ReviewDecision['decision']): Promise<void> {
  const body: ReviewDecision = { decision };
  return apiEmpty(`/api/review/${seg(enrollmentId)}`, { method: 'POST', body: json(body) });
}

export function getCallPlans(campaignId: string, opts: { cursor?: string | null; stage?: CallStage | null } = {}): Promise<CallPlansResponse> {
  const query = new URLSearchParams();
  if (opts.cursor) query.set('cursor', opts.cursor);
  if (opts.stage) query.set('stage', opts.stage);
  const qs = query.toString();
  return api(`/api/campaigns/${seg(campaignId)}/call-plans${qs ? `?${qs}` : ''}`, CallPlansResponse);
}

export function editCallPlan(enrollmentId: string, req: EditCallPlanRequest): Promise<CallPlanCard> {
  return api(`/api/call-plans/${seg(enrollmentId)}`, CallPlanCard, { method: 'PUT', body: json(req) });
}

export function approveCallPlan(enrollmentId: string, version: number): Promise<CallPlanCard> {
  return api(`/api/call-plans/${seg(enrollmentId)}/approve`, CallPlanCard, { method: 'POST', body: json({ version }) });
}

export function rejectCallPlan(enrollmentId: string): Promise<CallPlanCard> {
  return api(`/api/call-plans/${seg(enrollmentId)}/reject`, CallPlanCard, { method: 'POST' });
}

export function researchAgain(enrollmentId: string): Promise<CallPlanCard> {
  return api(`/api/call-plans/${seg(enrollmentId)}/research`, CallPlanCard, { method: 'POST' });
}

export function releaseCalls(campaignId: string): Promise<ReleaseCallsResponse> {
  return api(`/api/campaigns/${seg(campaignId)}/ai-calls/release`, ReleaseCallsResponse, { method: 'POST' });
}

export function getAiCallResults(campaignId: string, cursor?: string | null): Promise<AiCallResultsResponse> {
  return api(`/api/campaigns/${seg(campaignId)}/ai-calls${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, AiCallResultsResponse);
}

export function getAiCallTranscript(aiCallId: string): Promise<AiCallTranscript> {
  return api(`/api/ai-calls/${seg(aiCallId)}/transcript`, AiCallTranscript);
}

export function getAiAvailability(): Promise<AiAvailability> {
  return api('/api/ai-calls/availability', AiAvailability);
}

/** Admin only: the AI agent calls one of the CTI's test numbers. The answer is cti-api's (placed, or why not). */
export function startTestCall(to: string): Promise<TestCallResponse> {
  const body: TestCallRequest = { to };
  return api('/api/ai-calls/test', TestCallResponse, { method: 'POST', body: json(body) });
}
