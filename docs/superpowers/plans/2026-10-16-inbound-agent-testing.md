# Inbound Agent Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phones on an admin-managed **Test phones** list get the AI agent when they call one of the AI's numbers, using its own editable **inbound** prompt (default: the owner's "Sam / I Buy SD" prompt). The same list is where admins add **any number** for outbound test calls. A new **Testing** page manages the list and shows recent inbound test calls, with the details the agent saved and the transcript.

**Architecture:**
- **Routing.** The Twilio inbound voice webhook (cti-api `routes/inbound.ts`) gets one new branch for calls to an `ai_pool` number from a listed test phone. That branch inserts an `ai_calls` row (`direction='inbound'`, `is_test`), registers an active call, and answers with the same `<Connect><Stream>` TwiML outbound AI calls use. Any other caller, and any failure in that branch, falls through to today's routing unchanged.
- **Session.** `stream-session` builds inbound instructions from the new prompt kind `inbound`, plus fixed line rules that are not editable. Inbound calls get their own tool list (`save_caller_details`, `end_call`) and an opener that answers right away.
- **Admin side.** outreach-api adds test-phone CRUD and an inbound-calls listing. outreach-web adds the Testing page and a third Agent prompt tab.

**Tech Stack:** TypeScript, Fastify, Drizzle/Postgres, Zod (`@cti/contracts`), Mustache 4.2.0, OpenAI Realtime, Twilio Media Streams, React + TanStack Router/Query, Vitest.

**Spec:** none written. The source is the owner's chat request (2026-10-16): "add in any number that I want on the testing … a completely different testing section for inbound with its own system prompt … where we can call the agents"; "whatever number the agent has"; the prompt they pasted. The decisions below are the controller's and are recorded here; rulings made without a spec are provisional.

## Global Constraints

- **Real routing is unchanged** for any caller not on the list. A disabled switch, unavailable AI voice, an unparsable or anonymous From, a DB error, or any throw in the new branch: log a warning (codes only), then fall through to today's routing (rep ring / voicemail) exactly as now.
- **The outbound AI call path stays byte-identical:**
  - the outbound prompt golden (`__fixtures__/prompt-golden.json`), the prompt snapshot and the hash pins;
  - every existing bridge test unmodified;
  - instant-mode frames unchanged;
  - `toolsFor(slots)` output unchanged.
- **The inbound default prompt** is `services/cti-api/src/ai-voice/prompt-default-inbound.ts`, written by the controller as the owner's words verbatim. Do not change its text.
- **Inbound AI calls:**
  - are test calls (`is_test=true`, `practice=false`);
  - are not recorded (no audio stored, as for all AI calls);
  - never write Salesforce, a `calls` row, or an opt-out.
- **Logs** carry numbers, enums and codes only: never transcript text, prompt text, or caller details. Phone numbers are logged only the way existing ai-voice logs already do (follow the surrounding code).
- **Code rules:**
  - immutable updates;
  - files under 800 lines, and `services/cti-api/src/ai-voice/bridge.ts` must stay ≤ 800 (it is 784; put new bridge options/defaults in `bridge-session.ts`);
  - functions under 50 lines;
  - user-facing copy in plain words.
- **Git and safety:**
  - commits are `<type>(<scope>): <description>`, with NO trailer;
  - stage explicit paths only;
  - no push, no checkout/switch/reset/stash;
  - never read `.env` files or print secrets;
  - no remote DB;
  - subagents never spawn subagents or reviewers.
- **Test-phones list:**
  - per org, at most `TEST_PHONES_MAX = 25` numbers, stored as strict E.164;
  - the same list gates outbound test calls (together with the existing `AI_VOICE_TEST_NUMBERS` env list, kept for compatibility);
  - page copy: "Only add phones whose owners agreed to get test calls from the agent."

## Review Focus

1. **Callers not on the list keep today's routing.** A From that is `anonymous` or unparsable, or a number not on the list, calling an AI number must get today's TwiML exactly: rep ring, or voicemail with `<Record>`. It must still get a `calls` row and the Salesforce sync it gets today. → Task 2 (inbound.ts tests).
2. **Hang-up mid-call.** When the caller hangs up mid-sentence, the inbound row ends `completed`, with outcome = the saved `status`, or `incomplete` when none was saved. It must not leave a `calls` row, a Salesforce Task or an opt-out. The sweeper must never end a live inbound call that runs longer than 3 minutes. → Task 2 (finalize + sweeper tests).
3. **Spoken JSON.** The JSON block in the owner's prompt must never be spoken. The fixed line rules are always appended, including after a saved inbound template, and including after the default fallback. → Task 2 (prompt tests).
4. **Parallel inbound calls.** The same test phone calling twice, or two test phones calling at once, must get two rows and two sessions with no cross-talk. Inbound rows must not count toward outbound warm-up/velocity caps, callback routing, or sticky caller-ID. → Task 2 (query filter tests).
5. **Removing a test phone.** Removing a phone mid-call leaves that call running. The phone's next call routes as today. Adding a phone already on the list → 409; a 26th phone → 400; a non-number → 400. → Tasks 2 and 3.

---

### Task 1: Database and contracts

**Files:**
- Create: `packages/db/migrations/0061_inbound_agent_testing.sql`
- Create: `packages/db/src/schema-outreach-ai-test-phones.ts` (export it the way `schema-outreach-ai-prompts.ts` is exported)
- Create: `packages/db/src/migration-0061.test.ts` (pin the SQL the way `migration-0060.test.ts` does)
- Modify: `packages/db/src/schema.ts` (`aiCalls.direction`)
- Modify: `packages/db/src/schema-outreach-ai-prompts.ts:15` (`AI_AGENT_PROMPT_KINDS` adds `'inbound'`)
- Modify: `packages/db/src/migration-0060.test.ts:55-56`. The kinds-constant pin moves to the 0061 test; the 0060 file text pins stay.
- Modify: `packages/contracts/src/agent-prompts.ts`
- Create: `packages/contracts/src/testing.ts` and export it from the contracts index.

**Interfaces (Produces):**
- **Migration 0061.** It starts with `SET LOCAL lock_timeout = '5s';` like its siblings.
  - `ALTER TABLE ai_calls ADD COLUMN direction text NOT NULL DEFAULT 'outbound'` with `CONSTRAINT ai_calls_direction_check CHECK (direction IN ('outbound','inbound'))`.
  - Drop and re-add `ai_agent_prompts_kind_check` as `CHECK (kind IN ('instructions','voicemail','inbound'))`.
  - `CREATE TABLE ai_test_phones` with columns:
    - `id uuid PK default gen_random_uuid()`
    - `org_id uuid NOT NULL` (FK to the org table, same as 0060, `ON DELETE CASCADE`)
    - `e164 text NOT NULL`
    - `label text NOT NULL DEFAULT ''`
    - `added_by uuid NOT NULL` (FK users, same as 0060's `created_by`)
    - `created_at timestamptz NOT NULL DEFAULT now()`
    - `CONSTRAINT ai_test_phones_org_e164_unique UNIQUE (org_id, e164)`
  - Follow 0060's naming and FK conventions exactly.
- **Drizzle.**
  - `aiCalls.direction: text('direction', { enum: ['outbound','inbound'] }).notNull().default('outbound')`, or the repo's idiom for a text enum.
  - `aiTestPhones` table with `orgId`, `e164`, `label`, `addedBy`, `createdAt`.
  - `AI_TEST_PHONE_DIRECTIONS` is not needed. Export `AI_CALL_DIRECTIONS = ['outbound','inbound'] as const`.
- **Contracts `agent-prompts.ts`:**
  - `AgentPromptKind = z.enum(['instructions','voicemail','inbound'])`
  - `AGENT_PROMPT_MAX_CHARS.inbound = 60_000`
  - `AgentPromptsResponse` adds `inbound: AgentPromptState`
- **Contracts `testing.ts`:**
  - `TEST_PHONES_MAX = 25`
  - `INBOUND_TEST_CALLS_SHOWN = 20`
  - `TestPhone = z.object({ id: z.string().uuid(), e164: z.string(), label: z.string(), addedByEmail: z.string().nullable(), createdAt: z.string() })`
  - `TestPhonesResponse = z.object({ phones: z.array(TestPhone) })`
  - `AddTestPhoneRequest = z.object({ phone: z.string().trim().min(1).max(40), label: z.string().trim().max(60).default('') }).strict()`
  - `INBOUND_STATUSES = ['qualified','callback','disqualified','incomplete'] as const`
  - `INBOUND_DETAIL_FIELDS = ['location','timeline','price_expectation','condition','decision_maker','urgency','best_callback_time','notes'] as const`
  - `InboundCallDetails = z.object({ status: z.enum(INBOUND_STATUSES).optional(), ...each INBOUND_DETAIL_FIELDS key: z.string().optional() })`. Not strict, because rows may hold older keys.
  - `InboundTestCall = z.object({ id: z.string().uuid(), callerE164: z.string(), callerLabel: z.string().nullable(), aiNumber: z.string().nullable(), status: z.string(), outcome: z.string().nullable(), startedAt: z.string(), durationSeconds: z.number().int().nullable(), details: InboundCallDetails })`
  - `InboundTestCallsResponse = z.object({ aiNumbers: z.array(z.string()), calls: z.array(InboundTestCall) })`
  - Route path constants used by outreach-api and the web client:
    - `TESTING_PHONES_PATH = '/api/testing/phones'`
    - `TESTING_INBOUND_CALLS_PATH = '/api/testing/inbound-calls'`

- [ ] **Step 1:** Write `migration-0061.test.ts` (SQL text pins: the direction column + check, the kind check with 3 kinds, the table + unique) and contract tests (`AddTestPhoneRequest` strict, label default `''`, kind enum has 3 values, `AgentPromptsResponse` requires `inbound`). Run and see them FAIL.
- [ ] **Step 2:** Implement the migration, schema and contracts. Fix every compile error the widened `AgentPromptKind` causes **only inside packages/**. The cti-api/outreach-api/outreach-web consumers belong to Tasks 2–3 and may stay red until then; list them in the report.
- [ ] **Step 3:** Run `npx vitest run packages/db packages/contracts` and `npm run typecheck -w packages/db -w packages/contracts` (or the repo's equivalent). Expect PASS. Build the packages if consumers import `dist` (as `@cti/auth` did: `npm run build -w packages/<name>`).
- [ ] **Step 4:** Commit `feat(db): ai_calls.direction, the inbound prompt kind and the test-phones table` and `feat(contracts): inbound prompt kind and testing contracts` (one commit is fine).

### Task 2: cti-api, the inbound agent

**Files (main ones; follow the code):**
- **Prompt and tools:**
  - `ai-voice/prompt-template.ts` (`DEFAULT_TEMPLATES.inbound = DEFAULT_INBOUND_TEMPLATE`, `PLACEHOLDERS.inbound`, `SAMPLE_INPUT`)
  - `ai-voice/prompt-view.ts`
  - `ai-voice/prompt.ts`, or a new `ai-voice/prompt-inbound.ts`
  - `ai-voice/prompt-tools.ts`
  - `ai-voice/service-tools.ts`
  - `ai-voice/bridge-tools.ts`
- **Saved prompts:** `ai-voice/store.ts` (`templatesOfRows` adds inbound, direction filters, insert takes direction), `ai-voice/prompt-saved.ts`, `ai-voice/testing.ts` (fake store).
- **Call path:**
  - `ai-voice/inbound-call.ts` (new): the start of an inbound AI call
  - `ai-voice/test-phones.ts` (new): the list lookups
  - `routes/inbound.ts` (one branch)
  - `ai-voice/registry.ts` (`direction`)
  - `ai-voice/stream-session.ts`
  - `ai-voice/bridge-session.ts`, and `bridge.ts` only to read the opener option (≤ 800 lines)
  - `ai-voice/service-finalize.ts`, `ai-voice/sweeper.ts`
  - `ai-voice/number-pool.ts`
  - `ai-voice/gate.ts:105`, `ai-voice/routes-internal.ts:159-166`
  - `config.ts` (`AI_VOICE_INBOUND`)
- Tests next to each.

**Interfaces:**
- Consumes (Task 1): `aiCalls.direction`, `aiTestPhones`, `AgentPromptKind` incl. `'inbound'`, `AGENT_PROMPT_MAX_CHARS.inbound`, `INBOUND_STATUSES`, `INBOUND_DETAIL_FIELDS`.
- Produces (Task 3 reads these through the DB only; no new internal HTTP route):
  - inbound rows in `ai_calls` with `direction='inbound'`, `is_test=true`, `to_e164` = caller, `from_e164` = the AI number dialed, `started_by` = the test phone's `added_by`;
  - details in `ai_calls.qualification` (keys from `INBOUND_DETAIL_FIELDS` + `status`);
  - outcome = saved `status` or `'incomplete'`;
  - transcript in `ai_calls.transcript` as today.

**Decisions (exact values):**
- **Config.** `AI_VOICE_INBOUND: z.enum(['on','off']).default('on')`. `off` means test phones route as today. Document it in the config doc block and `.env.example`, next to the AI_VOICE_* lines.
- **Branch condition (`routes/inbound.ts`).** Goes after the `owned` / `inboundEnabled` check (~:219) and before `sharedPool` (~:238), so it comes before `insertInboundCall`. Condition: `owned.kind === 'ai_pool'`.
  - Call `tryInboundAiCall(deps, { orgId: owned.orgId, callerE164: normFrom, aiNumber: owned.e164, callSid })` from `ai-voice/inbound-call.ts`. It returns TwiML or `null`. On TwiML, send it as `text/xml`; on `null`, carry on as today.
  - It returns `null` when:
    - `AI_VOICE_INBOUND` is off;
    - AI voice is not available (the same check `onStart` uses);
    - the caller is not a strict E.164 (`toE164`) or not on the org's list;
    - anything throws. Then warn `ai-voice: inbound test call not started` with `{ reason }`, and never rethrow.
- **Start.** `startInboundAiCall`:
  - `loadAgentPrompts`;
  - insert the `ai_calls` row with `status 'queued'`, `direction 'inbound'`, `isTest true`, `practice false`, `sfObject null` and `callSid`;
  - `registerActiveCall` with `direction: 'inbound'`, `record: null`, `callSid`, and the prompt input (`callerNumber`, `templates`, `agentName`/`companyName` from config as outbound does, `isTest: true`);
  - return `streamTwiml(aiCallId, …)`, unchanged.
  - `onStart` must accept it unchanged (status queued → in_progress).
  - `ActiveAiCall.direction: 'outbound' | 'inbound'` is required; existing callers set `'outbound'`.
- **Placeholders.** `PLACEHOLDERS.inbound`:
  - `agent_name`, `company_name` (same as instructions);
  - `caller_number`: "the number the caller is calling from, written like 619-555-0100", formatted like the existing callback number;
  - `local_time`: the caller's local time, as the instructions' local-time placeholder does. Reuse it if it exists.
  - `SAMPLE_INPUT` gains a caller number. The default uses none of these and must pass `checkTemplate('inbound', null)` with no problems.
- **Instructions.** `buildInboundInstructions(p: PromptInput, onTemplateError?: TemplateErrorHandler): string` returns `promptText('inbound', p, onTemplateError) + '\n\n' + INBOUND_LINE_RULES`. The constant is exported and its text is exact:

  ```
  # How this phone line works (always applies)
  - This is a live phone call: everything you say is spoken aloud. Never say JSON, field names, brackets or tags.
  - Save what the caller tells you with the save_caller_details tool, silently, as you learn it — call it in the same reply as your next sentence or question, never announce it, and call it once more with "status" before you say goodbye. This replaces any instruction above to output JSON or a summary at the end of the call.
  - If the caller wants to go, or once you have said goodbye, call end_call.
  ```
- **Tool `save_caller_details`.**
  - Add it to `TOOL_NAMES`, with a closed schema: `status` enum `INBOUND_STATUSES`, plus each `INBOUND_DETAIL_FIELDS` key as a string. All optional.
  - Description: "Save what the caller told you — only the fields you learned; call again as you learn more. Silent: never announce it."
  - Persist through a `ToolEffects` method → `store.mergeQualification(aiCallId, fields)`. Filter to the known keys, trim, 500 chars max (notes 1,000). Drop an invalid `status`. Reply with the existing `SAVED_OUTPUT`, `then: 'continue'`.
  - `INBOUND_TOOLS: RealtimeFunctionTool[] = [save_caller_details, end_call]`, exported from `prompt-tools.ts`. `toolsFor(slots)` is unchanged.
  - `handleToolCall` refuses (as "unknown tool") any tool not offered to that call's direction.
  - `followUpAfterTools` treats `save_caller_details` exactly like `save_qualification`.
- **Opener.** `BridgeOptions.opener?: { delayMs: number; prompt: string }`. The default is today's `OPENER_DELAY_MS` and `OPENER_PROMPT`, unchanged. Inbound uses `INBOUND_OPENER = { delayMs: 300, prompt: '(Someone just called in and the line is open. Answer now with your greeting.)' }`. The gate still never cuts the opener.
- **`stream-session` `startBridge`.** When `entry.direction === 'inbound'`, use `buildInboundInstructions`, `INBOUND_TOOLS` and `INBOUND_OPENER`. Everything else is identical to outbound.
- **Finalize.** An inbound row finalizes at bridge end, because Twilio sends no status callback for it. Write:
  - `status 'completed'`, `ended_at`, `duration_seconds`;
  - outcome = `qualification.status` if valid, else `'incomplete'`;
  - no `calls` row (the `ctiCallValues` path is skipped for inbound), no Salesforce, no opt-out.
  - The sweeper may close an inbound row only after its active-call entry is gone (stream never started, or the process restarted), and never writes a `calls` row for it. Prove with tests that a live inbound call of 4+ minutes is not swept.
- **Direction filters.** `aiCallbackRepQuery`, `uncountedPlacedQuery` and `lastAiFromQuery` add `direction = 'outbound'`. Decide `activeCallToQuery` and write the reason in the report.
- **Test numbers for outbound test calls.** The gate (`gate.ts` ~:105) and the internal availability (`routes-internal.ts` `testNumbers`) use the union of `parseTestNumbers(cfg.AI_VOICE_TEST_NUMBERS)` and the org's `ai_test_phones`, via `test-phones.ts` `testPhoneNumbers(db, orgId): Promise<ReadonlySet<string>>`. Also add `findTestPhone(db, orgId, e164): Promise<{ id: string; addedBy: string; label: string } | null>`.

- [ ] **Step 1: Write the failing tests first and see RED.**
  - **inbound.ts:**
    - test phone → `<Connect><Stream>`, no `calls` row, no Salesforce enqueue;
    - non-test caller → today's TwiML byte-for-byte (rep ring and voicemail cases);
    - anonymous From → today's;
    - switch off → today's;
    - AI unavailable → today's;
    - lookup throws → today's + warn.
  - **inbound-call:** the row fields and the registry entry.
  - **stream-session (inbound entry):**
    - instructions end with `INBOUND_LINE_RULES`;
    - tools are exactly `INBOUND_TOOLS`;
    - the opener option is `INBOUND_OPENER`;
    - an outbound entry is unchanged.
  - **prompt:**
    - the default inbound renders `DEFAULT_INBOUND_TEMPLATE` verbatim + rules;
    - a saved inbound template is used + rules;
    - an empty-rendering saved template falls back + rules;
    - `checkTemplate('inbound', null)` has no problems;
    - the outbound golden is untouched.
  - **tools:**
    - `save_caller_details` filters keys, caps lengths, drops a bad status;
    - it is refused on an outbound call;
    - `transfer_to_rep` is refused on an inbound call;
    - `followUpAfterTools` treats it like a note save.
  - **finalize:**
    - inbound hang-up → completed + outcome from status / `incomplete`;
    - no `calls` row;
    - sweeper rules.
  - **queries:** each direction filter.
  - **gate/availability:** the union.
  - **config:** default and enum.
- [ ] **Step 2: Implement until GREEN.** Check `wc -l` on every file you touched (bridge.ts ≤ 800).
- [ ] **Step 3: Verify.**
  - `npx vitest run services/cti-api/src/ai-voice services/cti-api/src/routes`;
  - `npm run typecheck -w services/cti-api`;
  - then the full cti-api suite once.
  - Report the exact commands and pass counts.
- [ ] **Step 4: Commit** `feat(ai-voice): test phones calling an AI number get the inbound agent, with its own prompt and a save tool`. A separate commit for the gate union is fine.

### Task 3: outreach-api and outreach-web, the Testing page

**Files:**
- **outreach-api:**
  - `services/outreach-api/src/routes/testing.ts` (new) + test; register it in `server.ts` like `agent-prompts`
  - `routes/agent-prompts.ts` (`KINDS`, `KIND_WORDS.inbound = 'inbound call instructions'`, GET includes `inbound`)
  - `ai-calls/results-query.ts` (`loadTranscript` also finds an org's `direction='inbound'` row)
- **outreach-web:**
  - `routes/_authenticated/testing.tsx` (new)
  - `components/testing-page.tsx` (new; split into small components)
  - `lib/outreach-api.ts` (client functions)
  - `components/app-nav.tsx` (item "Testing", `adminOnly`, a lucide icon such as `PhoneIncoming`)
  - `components/agent-prompt-editor.tsx` (`KIND_LABELS.inbound = 'Inbound calls'`)
  - `test/agent-prompt-fixtures.ts`
  - `routeTree.gen.ts` (regenerate)
  - copy that names `AI_VOICE_TEST_NUMBERS` (`ai-test-call.tsx:45`, `practice-call.tsx:15`, `record-test-run.tsx:18`, `call-words.ts:126`) now points to "Test phones on the Testing page"
- **Docs:** `docs/runbooks/ai-voice.md`, new section "§21 Inbound testing and test phones".

**Interfaces:**
- Consumes (Task 1): `TestPhone`, `TestPhonesResponse`, `AddTestPhoneRequest`, `TEST_PHONES_MAX`, `InboundTestCall(s)Response`, `INBOUND_TEST_CALLS_SHOWN`, `INBOUND_DETAIL_FIELDS`, `INBOUND_STATUSES`, the path constants, the `ai_test_phones` table, `ai_calls.direction`, and `AgentPromptsResponse.inbound`.
- Consumes (Task 2, via the DB only): inbound rows as described in Task 2's Produces.

**Routes:** all admin-only (`requireContext` + `requireAdmin`) and org-scoped.
- `GET /api/testing/phones` → `TestPhonesResponse`, oldest first, with the adder's email.
- `POST /api/testing/phones` with body `AddTestPhoneRequest`:
  - normalize with `@cti/phone` `toE164` (US default, as elsewhere);
  - 400 `{ error: "That doesn't look like a phone number" }`;
  - 409 `{ error: 'That phone is already on the list' }`;
  - 400 `{ error: 'The list is full (25 phones) — remove one first' }`;
  - 201 → `TestPhone`; `added_by` = the admin.
- `DELETE /api/testing/phones/:id` → 204; 404 when it isn't in the org.
- `GET /api/testing/inbound-calls` → `InboundTestCallsResponse`:
  - `aiNumbers` = the org's `ai_pool` numbers with `inbound_enabled`, ordered by e164;
  - `calls` = the newest 20 `ai_calls` rows with `direction='inbound'`, with `callerLabel` from `ai_test_phones` (left join on org + e164) and `details` parsed with `InboundCallDetails` (a bad row → `{}`).

**Page `/testing`:** title "Testing". The page checks admin like the Agent prompt page. Sections:
1. **Test phones.**
   - Intro: "Phones on this list can get test calls from the agent, and when they call one of the agent's numbers, the agent answers."
   - Then: "Only add phones whose owners agreed to get test calls from the agent."
   - The list shows the number (formatted), the label and who added it. Each row has **Call this phone** (the existing outbound test-call client, `startTestCall` → `POST /api/ai-calls/test` with that number) and **Remove** (confirm first).
   - Add form: phone + optional label, **Add phone**. The API's error sentence shows inline.
2. **Inbound calls.**
   - "Call {the AI number(s), formatted} from a phone on the list and the agent answers with the inbound prompt."
   - Link **Edit the inbound prompt** → `/settings/agent-prompt`, opening on the Inbound calls tab if that's simple (a `tab` search param); otherwise just the page.
   - With no AI number: "No agent number takes calls yet."
   - Recent inbound test calls, refreshed every 10 s while the page is open. Each shows:
     - time, caller (label or formatted number), duration;
     - a status badge (qualified / callback / disqualified / incomplete, or "in progress");
     - the saved details as label/value rows (Location, Timeline, Price expectation, Condition, Decision maker, Urgency, Best callback time, Notes). Empty fields are hidden.
     - **Transcript** reuses `AiCallTranscriptPanel`.
   - Empty state: "No inbound test calls yet."

- [ ] **Step 1: Write the failing tests and see RED.**
  - **Route tests:**
    - admin only (403 for a non-admin);
    - validation (non-number, duplicate, full list);
    - org scoping (another org's phone → 404 on delete; its calls never listed);
    - the inbound listing (label join, details parse, bad JSON → `{}`, at most 20);
    - `loadTranscript` finds an inbound row in the org and 404s for another org's.
  - **Web tests:**
    - list/add/remove/call flows with error copy;
    - inbound section with numbers, empty states, details and transcript toggle;
    - nav item for admins only;
    - the Agent prompt page shows 3 tabs.
- [ ] **Step 2: Implement until GREEN.** Keep components small (< 200 lines each).
- [ ] **Step 3: Verify.**
  - outreach-api: its suite + `npm run typecheck -w services/outreach-api`;
  - outreach-web: from `apps/outreach-web`, `npx vitest run` + `npm run typecheck -w apps/outreach-web`.
  - Report the commands and pass counts.
- [ ] **Step 4: Commit.**
  - `feat(outreach-api): test phones and inbound test calls`
  - `feat(outreach-web): Testing page — test phones and inbound test calls; inbound prompt tab`
  - `docs(ai-voice): inbound testing runbook`
