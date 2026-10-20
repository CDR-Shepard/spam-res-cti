import { z } from 'zod';
import {
  AgentPromptCheck,
  AgentPromptState,
  AgentPromptsResponse,
  AgentPromptVersionBody,
  AiAvailability,
  AppVersion,
  AiCallSettings,
  SalesforceUserOption,
  AiCallResultsResponse,
  AiCallTranscript,
  AuthProviders,
  BrowserTokenResponse,
  Campaign,
  CandidatePage,
  CampaignPlanResponse,
  CampaignPreview,
  CallPlanCard,
  CallPlansResponse,
  CampaignsResponse,
  ReleaseCallsResponse,
  ConversationView,
  CrmConnectionStatus,
  EmailDraftResponse,
  EmailSendResponse,
  InboundTestCallsResponse,
  ListViewsResponse,
  NeedsReviewResponse,
  PracticeCallsResponse,
  RecordTest,
  RecordTestDryRun,
  RecordTestEmailPreview,
  RecordTestsResponse,
  SamEmailSettings,
  SelectionResponse,
  StartConnectionResponse,
  TESTING_INBOUND_CALLS_PATH,
  TESTING_PHONES_PATH,
  TestCallResponse,
  TestPhone,
  TestPhonesResponse,
  WritebackReadiness,
  type AgentPromptKind,
  type AgentPromptPreviewRequest,
  type AddTestPhoneRequest,
  type AgentPromptSaveRequest,
  type CallStage,
  type CampaignStatusChange,
  type ConversationHandler,
  type EditCallPlanRequest,
  type EmailDraftRequest,
  type EmailSendRequest,
  type HandlerChangeRequest,
  type CreateCampaignInput,
  type EnrollmentStatus,
  type FieldMap,
  type PracticeCallRequest,
  type PreviewRequest,
  type RecordTestCallRequest,
  type ReviewDecision,
  type SamEmailSettingsSave,
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
  appVersion: ['app', 'version'] as const,
  aiCallSettings: ['settings', 'ai-calls'] as const,
  salesforceUsersById: (ids: readonly string[]) => ['salesforce', 'users', 'ids', ids.join(',')] as const,
  practiceCallLists: ['campaigns', 'practice-calls'] as const,
  practiceCalls: (campaignId: string) => ['campaigns', 'practice-calls', campaignId] as const,
  writebackReadiness: ['settings', 'ai-calls', 'readiness'] as const,
  recordTests: ['record-tests'] as const,
  recordTest: (id: string) => ['record-tests', id] as const,
  agentPrompts: ['settings', 'agent-prompts'] as const,
  testPhones: ['testing', 'phones'] as const,
  inboundTestCalls: ['testing', 'inbound-calls'] as const,
  sellerConversation: (sfRecordId: string) => ['sellers', 'conversation', sfRecordId] as const,
  samEmailSettings: ['settings', 'sam-email'] as const,
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

/** The commit the live app and the AI voice server run, and when the app last started (the sidebar's version tag). */
export function getAppVersion(): Promise<AppVersion> {
  return api('/api/version', AppVersion);
}

/** Admin only: the AI agent calls one of the CTI's test numbers. The answer is cti-api's (placed, or why not). */
export function startTestCall(to: string): Promise<TestCallResponse> {
  const body: TestCallRequest = { to };
  return api('/api/ai-calls/test', TestCallResponse, { method: 'POST', body: json(body) });
}

/** Admin only (plan 1D): appointment booking and Salesforce write-back settings. */
export function getAiCallSettings(): Promise<AiCallSettings> {
  return api('/api/settings/ai-calls', AiCallSettings);
}

export function saveAiCallSettings(settings: AiCallSettings): Promise<AiCallSettings> {
  return api('/api/settings/ai-calls', AiCallSettings, { method: 'PUT', body: json(settings) });
}

const SalesforceUserOptions = z.array(SalesforceUserOption);

/** Admin only: active standard Salesforce users whose name contains `search` (2–40 characters). */
export function searchSalesforceUsers(search: string): Promise<SalesforceUserOption[]> {
  return api(`/api/salesforce/users?${new URLSearchParams({ search }).toString()}`, SalesforceUserOptions);
}

/** Admin only: these Salesforce users (up to 20), inactive ones included, in the order asked. */
export function salesforceUsersById(ids: readonly string[]): Promise<SalesforceUserOption[]> {
  return api(`/api/salesforce/users?${new URLSearchParams({ ids: ids.join(',') }).toString()}`, SalesforceUserOptions);
}

/** Admin only (plan 1D): ring a test number with this lead's real record and plan `version`; never writes to Salesforce. */
export function practiceCall(enrollmentId: string, body: PracticeCallRequest): Promise<TestCallResponse> {
  return api(`/api/call-plans/${seg(enrollmentId)}/practice`, TestCallResponse, { method: 'POST', body: json(body) });
}

/** Admin only: the campaign's latest practice calls, newest first. */
export function practiceCalls(campaignId: string): Promise<PracticeCallsResponse> {
  return api(`/api/campaigns/${seg(campaignId)}/practice-calls`, PracticeCallsResponse);
}

/** Admin only: send a failed Salesforce write-back round again (its finished steps are kept). */
export function retryWriteback(aiCallId: string): Promise<void> {
  return apiEmpty(`/api/ai-calls/${seg(aiCallId)}/writeback/retry`, { method: 'POST' });
}

/** Admin only: can the connected Salesforce user write call results back and convert a Lead that books? */
export function writebackReadiness(): Promise<WritebackReadiness> {
  return api('/api/settings/ai-calls/readiness', WritebackReadiness);
}

const RecordTestCreated = z.object({ id: z.string().uuid() });
/** POST /api/record-tests/:id/calls: the row's id and cti-api's answer (placed, or why not). */
export const RecordTestCallResponse = z.object({ callId: z.string().uuid(), response: TestCallResponse });
export type RecordTestCallResponse = z.infer<typeof RecordTestCallResponse>;

/** Admin only (plan 1E): preview how the AI would call this Lead or Opportunity (an Id or a link); answers 202 at once. */
export function createRecordTest(record: string): Promise<{ id: string }> {
  return api('/api/record-tests', RecordTestCreated, { method: 'POST', body: json({ record }) });
}

/** Admin only: the tenant's latest 20 record tests. */
export function recordTests(): Promise<RecordTestsResponse> {
  return api('/api/record-tests', RecordTestsResponse);
}

/** Admin only: one record test, its preview and its calls. */
export function recordTest(id: string): Promise<RecordTest> {
  return api(`/api/record-tests/${seg(id)}`, RecordTest);
}

/** Admin only: run a ready preview to a test number, or to the browser registered under `identity`. */
export function recordTestCall(id: string, body: RecordTestCallRequest): Promise<RecordTestCallResponse> {
  return api(`/api/record-tests/${seg(id)}/calls`, RecordTestCallResponse, { method: 'POST', body: json(body) });
}

/** Admin only: an incoming-only Voice token for one "Talk in browser" run. Never stored, logged or cached. */
export function browserToken(): Promise<BrowserTokenResponse> {
  return api('/api/record-tests/browser-token', BrowserTokenResponse, { method: 'POST' });
}

/** Admin only (plan 1E): what a real call that ended like this test call would write to Salesforce. Nothing is sent. */
export function recordTestDryRun(callId: string): Promise<RecordTestDryRun> {
  return api(`/api/record-tests/calls/${seg(callId)}/dry-run`, RecordTestDryRun, { method: 'POST' });
}

/** Admin only: the first email Sam would write to a ready test's record. Nothing is sent or stored; each call is a paid draft. */
export function recordTestEmailPreview(testId: string): Promise<RecordTestEmailPreview> {
  return api(`/api/record-tests/${seg(testId)}/email-preview`, RecordTestEmailPreview, { method: 'POST' });
}

/** Admin only: the AI agent's call instructions and voicemail message, each with its saved text, the built-in default, the placeholders and the newest versions. */
export function getAgentPrompts(): Promise<AgentPromptsResponse> {
  return api('/api/settings/agent-prompts', AgentPromptsResponse);
}

/** Admin only: check `template` and render it against a sample lead without saving it. Problems come back in the 200 body. */
export function previewAgentPrompt(kind: AgentPromptKind, template: string): Promise<AgentPromptCheck> {
  const body: AgentPromptPreviewRequest = { template };
  return api(`/api/settings/agent-prompts/${seg(kind)}/preview`, AgentPromptCheck, { method: 'POST', body: json(body) });
}

/** Admin only: save a new version (the next call uses it); `null` goes back to the built-in default. A refused template answers 400 with its `problems`. */
export function saveAgentPrompt(kind: AgentPromptKind, template: string | null): Promise<AgentPromptState> {
  const body: AgentPromptSaveRequest = { template };
  return api(`/api/settings/agent-prompts/${seg(kind)}`, AgentPromptState, { method: 'PUT', body: json(body) });
}

/** Admin only: one saved version's text (`body` null = a reset to the default), to load an older version into the editor. */
export function getAgentPromptVersion(kind: AgentPromptKind, id: string): Promise<AgentPromptVersionBody> {
  return api(`/api/settings/agent-prompts/${seg(kind)}/versions/${seg(id)}`, AgentPromptVersionBody);
}

/** Admin only: the org's test phones (they can get test calls from the agent, and get the agent when they call one of its numbers), oldest first. */
export function getTestPhones(): Promise<TestPhonesResponse> {
  return api(TESTING_PHONES_PATH, TestPhonesResponse);
}

/** Admin only: add a phone as typed (the server makes it E.164). A refusal answers 400 or 409 with the sentence to show. */
export function addTestPhone(phone: string, label: string): Promise<TestPhone> {
  const body: z.input<typeof AddTestPhoneRequest> = { phone, label };
  return api(TESTING_PHONES_PATH, TestPhone, { method: 'POST', body: json(body) });
}

/** Admin only: take a phone off the list (a call it already has going carries on). */
export function removeTestPhone(id: string): Promise<void> {
  return apiEmpty(`${TESTING_PHONES_PATH}/${seg(id)}`, { method: 'DELETE' });
}

/** Admin only: the agent's numbers to dial, and the newest inbound test calls. */
export function getInboundTestCalls(): Promise<InboundTestCallsResponse> {
  return api(TESTING_INBOUND_CALLS_PATH, InboundTestCallsResponse);
}

/** One seller's page (plan 2026-10-19): the timeline, who handles the seller, and why Sam may not email. The record's owner or an admin. */
export function getSellerConversation(sfRecordId: string): Promise<ConversationView> {
  return api(`/api/sellers/${seg(sfRecordId)}/conversation`, ConversationView);
}

/** A person takes the seller over (`person`) or gives them back to Sam (`sam`; also clears a flag). Answers the page's new view. */
export function setSellerHandler(sfRecordId: string, handler: ConversationHandler): Promise<ConversationView> {
  const body: HandlerChangeRequest = { handler };
  return api(`/api/sellers/${seg(sfRecordId)}/handler`, ConversationView, { method: 'PUT', body: json(body) });
}

/** Admin only: ask Sam for a first email. `practice` addresses it to the admin's own sign-in address instead of the seller's. */
export function draftSellerEmail(sfRecordId: string, practice: boolean): Promise<EmailDraftResponse> {
  const body: EmailDraftRequest = { practice };
  return api(`/api/sellers/${seg(sfRecordId)}/email/draft`, EmailDraftResponse, { method: 'POST', body: json(body) });
}

/** Admin only: queue the (edited) draft. It is sent later, in the seller's sending hours; a practice copy goes out right away. */
export function sendSellerEmail(sfRecordId: string, req: EmailSendRequest): Promise<EmailSendResponse> {
  return api(`/api/sellers/${seg(sfRecordId)}/email/send`, EmailSendResponse, { method: 'POST', body: json(req) });
}

/** Admin only: whether Sam may email sellers, whether the server can, and any spam-complaint pause. */
export function getSamEmailSettings(): Promise<SamEmailSettings> {
  return api('/api/settings/sam-email', SamEmailSettings);
}

/** Admin only: turn Sam's email on (clears a pause) or off. Turning it on while the server is not set up answers 409 EMAIL_NOT_CONFIGURED. */
export function saveSamEmailSettings(enabled: boolean): Promise<SamEmailSettings> {
  const body: SamEmailSettingsSave = { enabled };
  return api('/api/settings/sam-email', SamEmailSettings, { method: 'PUT', body: json(body) });
}
