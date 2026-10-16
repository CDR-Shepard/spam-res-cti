# Editable Agent Prompts + "Lead Specialist" Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can edit the AI call agent's full instructions and its voicemail message in the web app. A save applies on the very next call. The web app is renamed "Lead Specialist" and gets a real logo.

**Architecture:**
- Prompts become Mustache templates rendered over the per-call data the code already computes. That data includes sanitised CRM notes, the approved call plan, booking times and the callback number.
- The built-in default templates reproduce today's prompt byte for byte.
- Each save is a new row in `ai_agent_prompts`: per org, per kind, append-only. The newest row is the active one; a row with no text means "use the default".
- cti-api reads the active rows when it places a call, renders them, and falls back to the default on any failure.
- cti-api alone knows the placeholders, so it also serves a signed internal "check and preview" endpoint. outreach-api uses that endpoint to validate a template before saving it and to preview it.

**Tech Stack:** TypeScript, Fastify, Drizzle and raw SQL migrations (packages/db), zod contracts (packages/contracts), React + TanStack Router + react-query (apps/outreach-web), vitest, `mustache@4.2.0` + `@types/mustache@4.2.6`.

**Spec:** none written. On 2026-10-16 the owner chose to skip the design questions ("just make it editable … take effect right away on the next call"; "rename the app to lead specialist … pick a good logo icon instead of the slash"). The decisions are recorded in Global Constraints. The owner edits the prompt content; the implementer never changes what the default prompt says.

## Global Constraints

- **Default output unchanged.** With no saved version, the agent's instructions and voicemail text are byte-identical to today's `buildInstructions` and `voicemailText` output for every input in the golden matrix (Task 3). Deploying changes nothing until someone saves.
- **Default content unchanged.** No implementer edits the wording of the default prompt or voicemail, including the AI and recording disclosure. Templates reproduce today's text exactly.
- **Immediate effect.** cti-api reads the active templates from the DB at call placement (`service.ts`, where `registerActiveCall` builds `prompt`), with no cache. A save applies to the next call placed.
- **A prompt never breaks a call.**
  - A DB read error at placement uses the defaults.
  - A custom template that throws while rendering uses the default.
  - Both log a warning at warn level with codes only: `{ kind, reason }`. Never log template text or lead data.
- **Validation at save.** These block the save with a readable message:
  - a Mustache parse error (with its line number when Mustache reports a position);
  - an unknown placeholder name (named in the message);
  - empty text after trimming;
  - instructions longer than 60,000 characters, or a voicemail longer than 1,500.

  Resetting to the default is a save with `template: null`. Saving needs a successful check from cti-api; if cti-api is unreachable the save is refused (503, "Can't check the prompt right now — try again in a minute") and nothing is stored.
- **Mustache rules.**
  - HTML escaping is off: `Mustache.render(t, view, {}, { escape: (s) => s })`. Never mutate the global `Mustache.escape`.
  - View values are only strings, booleans and arrays of objects, never functions, so lambdas can't run.
  - Data values are inserted literally: a `{{` inside CRM notes or a plan is not re-parsed.
  - Partials are not supported. A `{{> x}}` tag is reported as an unknown placeholder.
- **Placeholders** are snake_case. Each one has a one-line description in an exported `PLACEHOLDERS` list, served to the UI. There are two kinds: text (`{{first_name}}`) and section (`{{#call_plan}}…{{/call_plan}}`, `{{^call_plan}}…{{/call_plan}}`).
- **Access and tenancy.**
  - Every prompt route is admin-only (`requireContext` + `requireAdmin`) and scoped to the request's org.
  - cti-api reads only the calling org's rows.
  - The internal endpoint is signed like the other internal routes (`internalRequestHeaders` / `checkInternalRequest`).
- **Storage.**
  - Versions are append-only, and `body` NULL means the default.
  - Active = newest `created_at` per `(org_id, kind)`.
  - `kind` is `'instructions'` or `'voicemail'`.
  - `created_by` references `users(id) ON DELETE SET NULL`.
- **Rename scope.** Only user-visible copy in apps/outreach-web changes from "Outreach" to "Lead Specialist": `index.html` `<title>`, the sidebar `Wordmark`, the sign-in card title, and the sign-in error messages. These stay as they are: package and service names, URLs, env vars, Railway services, API paths, code identifiers, and the Salesforce values `'AI Outreach'` (consent-fields.ts, writeback/fields.ts).
- **Logo.** lucide-react `Headset` on the existing lime `bg-brand` tile with `text-brand-foreground`. It replaces the skewed slash in both `Wordmark` and the sign-in mark. Add an SVG favicon with the same mark at `apps/outreach-web/public/favicon.svg` and link it from `index.html`.
- **Conventions.** Repo style, immutable updates, TDD (RED then GREEN). Commits are `<type>(<scope>): <description>`, use explicit paths, have no trailer, and are never pushed. No checkout, switch, reset or stash. Never read `.env` files or secrets. No remote DB.

## Review Focus

1. **Typo'd placeholder** (`{{frist_name}}`): the save is refused with "Unknown placeholder: frist_name". Tested in Task 3 (`checkTemplate`) and Task 5 (PUT 400).
2. **Unclosed section** (`{{#call_plan}}` with no `{{/call_plan}}`): the save is refused, with the line number. Tested in Task 3 and Task 5.
3. **Custom template, sparse call data** (no first name, address, plan, slots or callback number): the render contains no "undefined", "null" or "[object Object]" and doesn't throw. Tested in Task 3.
4. **Lead data containing `{{`, `}}`, `</crm_notes>` or `</call_plan>`**: inserted literally and fence-neutralised as today. Tested in Task 3.
5. **Infrastructure failure.** cti-api down during save or preview → 503 and nothing stored (Task 5). DB read fails at call placement → default prompt, call proceeds, one warning logged (Task 4).

---

### Task 1: Rename the web app to "Lead Specialist" and replace the slash logo

**Files:**
- Modify: `apps/outreach-web/index.html` (title, favicon link)
- Create: `apps/outreach-web/public/favicon.svg`
- Modify: `apps/outreach-web/src/components/app-nav.tsx` (`Wordmark`)
- Modify: `apps/outreach-web/src/components/sign-in-page.tsx` (mark, title, `MESSAGES`)
- Test: `apps/outreach-web/src/components/sign-in-page.test.tsx`, plus the app-nav/app-shell test that covers `Wordmark` (find it; add one if none exists)

**Interfaces:** none consumed or produced.

- [ ] **Step 1: Failing tests.**
  - The sign-in page shows the heading "Lead Specialist".
  - `MESSAGES.no_tenant` is `'This Salesforce org is not set up for Lead Specialist. Contact your administrator.'`.
  - `MESSAGES.org_not_allowed` is `'This Salesforce org is not allowed to use Lead Specialist.'`.
  - `Wordmark` renders a link named "Lead Specialist" that contains an `svg` with class `lucide-headset`.
  - No rendered text in these components still contains "Outreach".
- [ ] **Step 2: Run them.** `npx vitest run apps/outreach-web/src/components/sign-in-page.test.tsx <nav test>` → FAIL.
- [ ] **Step 3: Implement.**
  - Swap the slash `<span>` for `<Headset className="size-[14px]" strokeWidth={2.2} />`; on the sign-in mark use `size-6`.
  - Change the copy.
  - Set `<title>Lead Specialist</title>` and add `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`.
  - favicon.svg is a 32×32 rounded square (rx 7) filled `#E4F222`, with lucide's headset paths (copied from the installed `lucide-react` icon source) stroked `#0F0F0E`, stroke-width 2, scaled to fit with about 5 px padding.
- [ ] **Step 4: Run** those tests, then `npm run typecheck -w apps/outreach-web` and the whole outreach-web suite once → PASS.
- [ ] **Step 5: Commit.** `feat(outreach-web): the app is now "Lead Specialist", with a headset logo and favicon`

---

### Task 2: Storage and contracts for prompt versions

**Files:**
- Create: `packages/db/migrations/0060_ai_agent_prompts.sql`, `packages/db/src/migration-0060.test.ts`, `packages/db/src/schema-outreach-ai-prompts.ts`. Export the table from `packages/db/src/index.ts` the way `schema-outreach-record-tests.ts` is exported.
- Create: `packages/contracts/src/agent-prompts.ts`. Export it from the contracts index the way neighbouring modules are exported.
- Test: `packages/contracts/src/agent-prompts.test.ts`

**Interfaces — Produces:**
- Table `ai_agent_prompts`:
  - `id uuid pk default gen_random_uuid()`
  - `org_id uuid not null → organizations on delete cascade`
  - `kind text not null check (kind in ('instructions','voicemail'))`
  - `body text null`
  - `created_by uuid null → users on delete set null`
  - `created_at timestamptz not null default now()`
  - Index `ai_agent_prompts_active_idx` on `(org_id, kind, created_at desc)`.
  - Migration header comment and `SET LOCAL lock_timeout = '5s'` as in 0059.
  - Drizzle export `aiAgentPrompts`.
- Contracts (zod + inferred types):
  - `AgentPromptKind = z.enum(['instructions','voicemail'])`
  - `AGENT_PROMPT_MAX_CHARS = { instructions: 60_000, voicemail: 1_500 } as const`
  - `AgentPromptPlaceholder = { name: string; kind: 'text' | 'section'; description: string }`
  - `AgentPromptCheck` (cti-api's answer) = `{ defaultTemplate: string; placeholders: AgentPromptPlaceholder[]; rendered: string | null; problems: string[] }`
  - `InternalAgentPromptCheckRequest = { kind: AgentPromptKind; template: string | null }` and `INTERNAL_AI_PROMPT_CHECK_PATH = '/internal/ai-voice/prompt-check'`. Use the existing `INTERNAL_AI_*_PATH` naming and prefix (check `INTERNAL_AI_CALLS_PATH`) and match its prefix exactly.
  - `AgentPromptVersionSummary = { id: string; createdAt: string; createdByEmail: string | null; isDefault: boolean; chars: number }`
  - `AgentPromptState = { kind; active: string | null; defaultTemplate: string; placeholders; updatedAt: string | null; updatedByEmail: string | null; versions: AgentPromptVersionSummary[] }`, where `versions` holds the newest 20.
  - `AgentPromptsResponse = { instructions: AgentPromptState; voicemail: AgentPromptState }`
  - `AgentPromptSaveRequest = { template: string | null }`
  - `AgentPromptPreviewRequest = { template: string }`
  - `AgentPromptVersionBody = { id: string; body: string | null }`

- [ ] **Step 1: Failing tests.**
  - The migration test follows `migration-0059.test.ts`: it pins the file name, the columns, the check constraint, the index and the lock timeout.
  - Contracts tests: the schemas accept valid shapes; `AgentPromptKind` rejects `'system'`; `AgentPromptSaveRequest` accepts `null` and rejects a number.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the migration, the Drizzle table and the contracts.
- [ ] **Step 4: Run** the packages/db and packages/contracts suites, plus typecheck for both → PASS.
- [ ] **Step 5: Commit.** `feat(db): ai_agent_prompts — per-org versions of the agent's instructions and voicemail`

---

### Task 3: Prompt templates in cti-api (defaults reproduce today's text exactly)

**Files:**
- Create: `services/cti-api/src/ai-voice/prompt-template.ts`
  - Renders and checks templates.
  - Exports `PLACEHOLDERS: Record<AgentPromptKind, AgentPromptPlaceholder[]>`.
  - Exports `renderPrompt(kind, template, input): string`, which throws on a bad template.
  - Exports `checkTemplate(kind, template | null): AgentPromptCheck`.
- Create: `services/cti-api/src/ai-voice/prompt-default-instructions.ts` and `prompt-default-voicemail.ts`. Each exports its default template as a string constant (`DEFAULT_INSTRUCTIONS_TEMPLATE`, `DEFAULT_VOICEMAIL_TEMPLATE`). Split the instructions into section constants joined together if one file would pass 400 lines.
- Create: `services/cti-api/src/ai-voice/prompt-view.ts`. Exports `promptView(input: PromptInput): Record<string, string | boolean | ReadonlyArray<Record<string, string>>>`, which turns the existing `context()` / booking / plan helpers into placeholder values.
- Create: `services/cti-api/src/ai-voice/__fixtures__/prompt-golden.json` (captured in Step 1) and `prompt-template.test.ts`. Each matrix entry is `{ name, input, instructionsSha256, voicemail }`: the instructions are pinned by hash to keep the file small, the voicemail by its full text.
- Modify: `prompt.ts`.
  - `buildInstructions(p)` and `voicemailText(p)` keep their signatures. Each renders `p.templates?.<kind>` when set, falling back to the default when it is unset or throws. The fallback is silent here; Task 4 adds an optional `onTemplateError` callback parameter for logging.
  - `PromptInput` gains `templates?: { instructions: string | null; voicemail: string | null }`.
- Modify: `package.json` of services/cti-api: add `mustache@4.2.0`, and add `@types/mustache@4.2.6` as a dev dependency.

**Interfaces — Consumes:** Task 2's `AgentPromptKind`, `AgentPromptPlaceholder`, `AgentPromptCheck`, `AGENT_PROMPT_MAX_CHARS`.

**Interfaces — Produces** (in `prompt-template.ts`):
- `renderPrompt(kind: AgentPromptKind, template: string, input: PromptInput): string`
- `checkTemplate(kind: AgentPromptKind, template: string | null): AgentPromptCheck`
  - For `template: null` it returns the default template, the placeholders, `rendered` of the default over `SAMPLE_INPUT`, and `problems: []`.
  - Otherwise it reports problems (parse error with line, unknown placeholders, empty, too long), and returns `rendered: null` when there are any.
- `SAMPLE_INPUT: PromptInput`, the preview's sample lead: Jane, 1234 Oak St Tampa, returning, a sample plan, two booking times with "Grant", callback number, not a test call.

- [ ] **Step 1: Capture the golden outputs before changing any prompt code.**
  - Write a throwaway script that calls the current `buildInstructions` and `voicemailText` over a matrix and writes `__fixtures__/prompt-golden.json`. The matrix covers:
    - firstName set and null; address set and null;
    - callbackNumber set and null; isTest true and false;
    - approvedPlan none and the PLAN from prompt-plan.test.ts; returning true and false;
    - slots: none, phone only, walkthrough only, both, and both with `specialistFirstName: null`.
  - Use about 40 combinations, including the all-null and all-set extremes.
  - Commit the JSON with the test that reads it; don't commit the script.
- [ ] **Step 2: Failing tests** in `prompt-template.test.ts`:
  - `default templates reproduce the golden outputs`: for every matrix entry, `sha256(buildInstructions(input)) === instructionsSha256` and `voicemailText(input) === voicemail`. A failure names the entry.
  - `a custom template renders the call's data`: `renderPrompt('instructions', 'Hi {{first_name}}{{#call_plan}} PLAN{{/call_plan}}', input)` gives `'Hi Jane PLAN'`, and `'Hi Jane'` when there is no plan.
  - `data is inserted literally`: notes containing `{{agent_name}}` and `</crm_notes>` render with the braces intact and the fence neutralised exactly as today (compare with `neutraliseFences`); no HTML escaping (`&` stays `&`).
  - `sparse data never prints undefined/null`: render the default and a custom all-placeholders template over the all-null input. The output contains none of `undefined`, `null` or `[object Object]`.
  - `checkTemplate` cases:
    - `'{{frist_name}}'` → problems contain `Unknown placeholder: frist_name`.
    - `'a\n{{#call_plan}}x'` → one problem mentioning `line 2`.
    - `'   '` → `Prompt is empty`.
    - 60,001 characters → `Prompt is longer than 60,000 characters`.
    - `'{{> partial}}'` → unknown placeholder.
    - `null` → `problems: []`, with `defaultTemplate` and the placeholders.
  - `buildInstructions falls back`: with `templates.instructions` set to a template that fails to parse, the output equals the default render.
  - `every placeholder used by the defaults is listed in PLACEHOLDERS, and every listed one is used by a default or documented as optional`.
  - Keep `prompt.test.ts`, `prompt-plan.test.ts` (hash pins) and the `prompt-first-call.txt` snapshot passing unchanged. They are the second oracle.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.**
  - Turn every conditional in today's prompt code into placeholders and sections. Today's conditionals are the person/property/phone lines, the test-call line, the plan section, the returning opener, the booking section and its kinds, the specialist name, `book_appointment`, the appointment outcome, and the screener's "about …" phrase.
  - The view computes exactly the strings today's code interpolates, using the same helpers. The sanitising helpers `context()`, `approvedPlanText` and `neutraliseFences` stay in force.
  - Render with `escape: (s) => s`.
  - Find unknown placeholders by walking `Mustache.parse` tokens, recursing into sections, and checking each name against `PLACEHOLDERS[kind]`.
  - Read the parse-error line from the error's position in the template, converting the character index to a 1-based line.
  - Delete the now-unused string-building code; prompt.ts and its siblings keep only what the view needs.
- [ ] **Step 5: Run** the src/ai-voice folder, `npm run typecheck -w services/cti-api`, then the full cti-api suite once → PASS.
- [ ] **Step 6: Commit.** `feat(ai-voice): the agent's instructions and voicemail are templates; the defaults reproduce today's text exactly`

---

### Task 4: cti-api uses the org's saved prompts and serves the check endpoint

**Files:**
- Modify: `services/cti-api/src/ai-voice/store.ts`. Add `activeAgentPrompts(orgId: string): Promise<{ instructions: string | null; voicemail: string | null }>`: the newest row per kind for that org, and `null` for a kind with no rows or a NULL body.
- Modify: `services/cti-api/src/ai-voice/testing.ts`, so `fakeStore` supports it.
- Modify: `services/cti-api/src/ai-voice/service.ts`.
  - At placement, call `activeAgentPrompts(session.orgId)`.
  - On error, log `deps.log.warn({ reason: 'db_error' }, 'ai-voice: agent prompts unavailable, using defaults')` and use `{ instructions: null, voicemail: null }`.
  - Put the result in `prompt.templates`.
- Modify: `stream-session.ts` and `routes-webhooks.ts` (the voicemail). A custom template that throws at render falls back to the default and logs `warn({ kind, reason: 'render_error' }, 'ai-voice: custom prompt failed, using default')`. Thread a logger callback into `buildInstructions`/`voicemailText` through an optional second parameter `onTemplateError?: (kind) => void`, rather than importing a logger into prompt code.
- Modify: `routes-internal.ts`. Add `POST INTERNAL_AI_PROMPT_CHECK_PATH`:
  - Signed with the same guard as the other internal routes.
  - The body is parsed with `InternalAgentPromptCheckRequest`; an invalid body gets 400.
  - It responds `200` with `checkTemplate(kind, template)`.
  - It never logs the template.
- Test: `service.test.ts`, `stream-session.test.ts`, `routes-internal.test.ts`, and `store` tests if they exist (follow the folder).

**Interfaces — Consumes:** Task 3's `checkTemplate` and `PromptInput.templates`. **Produces:** the internal endpoint that Task 5 calls.

- [ ] **Step 1: Failing tests.**
  - A placement with a stored custom instructions template registers `prompt.templates.instructions` equal to it. The stream's session.update `instructions` is that template rendered for the call.
  - With `activeAgentPrompts` rejecting, the call is still placed, the instructions equal the default, and one warn with `reason: 'db_error'` is logged.
  - A stored template that throws at render produces the default instructions and a warn with `reason: 'render_error'`.
  - The voicemail uses the custom voicemail template.
  - The check endpoint:
    - an unsigned request → 401;
    - `{kind:'instructions', template:null}` → `problems: []` and a non-empty `defaultTemplate`;
    - `'{{nope}}'` → `Unknown placeholder: nope`;
    - an invalid body → 400.
  - The store returns the newest row per kind, `null` when the newest body is NULL (a reset), and never another org's rows (if the folder has pg-backed store tests, use them; otherwise unit-test the query builder the way store.ts is tested).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the ai-voice folder, typecheck, and the full cti-api suite once → PASS.
- [ ] **Step 5: Commit.** `feat(ai-voice): calls use the org's saved prompts (default on any failure); internal prompt check endpoint`

---

### Task 5: outreach-api prompt routes (admin)

**Files:**
- Create: `services/outreach-api/src/routes/agent-prompts.ts` (+ `.test.ts`). Register it in `server.ts` like `registerAiCallSettingsRoutes`.
- Modify: `services/outreach-api/src/ai-calls/cti-client.ts`. Add `checkPrompt(req: InternalAgentPromptCheckRequest): Promise<{ kind: 'check'; check: AgentPromptCheck } | { kind: 'transport'; error: string }>`. It is signed with `internalRequestHeaders`, has a 5 s timeout and never throws.

**Interfaces — Consumes:** Task 2's contracts and table; Task 4's endpoint. **Produces** (for Task 6):
- `GET /settings/agent-prompts` → `AgentPromptsResponse`.
  - `defaultTemplate` and `placeholders` come from `checkPrompt({kind, template:null})`; if cti-api is unreachable the route answers 503.
  - `updatedByEmail` and each version's `createdByEmail` are joined from users.
- `POST /settings/agent-prompts/:kind/preview` with `AgentPromptPreviewRequest` → `AgentPromptCheck`. It always answers 200 with the problems, or 503 if cti-api is unreachable.
- `PUT /settings/agent-prompts/:kind` with `AgentPromptSaveRequest`.
  - `template: null` inserts a NULL-body row (reset).
  - Otherwise it checks first: problems → 400 `{ error: 'invalid_prompt', problems }`; unreachable → 503 `{ error: 'prompt_check_unavailable' }`.
  - On success it inserts the row with `created_by` set to the requesting user and returns the new `AgentPromptState`.
- `GET /settings/agent-prompts/:kind/versions/:id` → `AgentPromptVersionBody`. It answers 404 for another org's id or an unknown id.
- Every route: admin only (403 for a non-admin), org-scoped, `:kind` validated with `AgentPromptKind`, request bodies size-checked against `AGENT_PROMPT_MAX_CHARS` before calling cti-api, and no template text in logs.

- [ ] **Step 1: Failing tests** following `ai-call-settings.test.ts` (same app and DB harness):
  - A non-admin gets 403 on every route.
  - GET on a fresh org → `active: null`, the default template, the placeholders, and `versions: []`.
  - PUT valid → 200; GET then shows `active` equal to the text and one version with the user's email.
  - PUT with problems → 400 with the problems, and no row inserted.
  - PUT when the cti client returns transport → 503, and no row.
  - PUT null → reset; GET shows `active: null`, and the newest version has `isDefault: true`.
  - Preview passes the problems and the rendered text through.
  - The version body for another org's id → 404.
  - `:kind = 'system'` → 400.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the route tests, typecheck, and the full outreach-api suite once → PASS.
- [ ] **Step 5: Commit.** `feat(outreach-api): admin routes to read, check, preview, save and reset the agent prompts`

---

### Task 6: "Agent prompt" settings page in the web app, plus the runbook

**Files:**
- Create: `apps/outreach-web/src/routes/_authenticated/settings.agent-prompt.tsx` and `apps/outreach-web/src/components/agent-prompt-page.tsx` (+ `.test.tsx`). Split out an editor subcomponent if the page passes about 300 lines.
- Modify: `apps/outreach-web/src/lib/outreach-api.ts`. Add `getAgentPrompts()`, `previewAgentPrompt(kind, template)`, `saveAgentPrompt(kind, template | null)` and `getAgentPromptVersion(kind, id)`, parsed with the Task 2 schemas and following the existing client pattern.
- Modify: `apps/outreach-web/src/components/app-nav.tsx`. Add the nav item `{ to: '/settings/agent-prompt', label: 'Agent prompt', icon: ScrollText, adminOnly: true }` before Settings, and extend the `NavItem['to']` union.
- Modify: `docs/runbooks/ai-voice.md`. Add a new section "Editing the agent prompt": where it lives, that saves apply on the next call, the placeholders and sections, that every failure falls back to the default, where versions live (`ai_agent_prompts`), and how to reset.

**Interfaces — Consumes:** Task 5's routes, and Task 2's types.

**The page.**
- Header: "Agent prompt". Two tabs: "Call instructions" and "Voicemail message".
- Status line under the tabs: "Using the default" or "Edited <date, time> by <email>".
- Editor: a monospace `<textarea>` with `aria-label` "Call instructions" or "Voicemail message", at least 60vh tall for instructions. It starts with `active ?? defaultTemplate`.
- Buttons:
  - **Save**: disabled while unchanged or while saving. It shows the problems in a `role="alert"` list on 400, the 503 message on 503, and "Saved — the next call uses it." on success.
  - **Preview**: renders the sample lead, then shows problems or the rendered text in a read-only panel below the editor.
  - **Reset to default**: confirms first ("Go back to the built-in prompt? Your edits stay in Previous versions."), then saves null.
- **Placeholders**: a collapsible list built from the server's `placeholders`: name, kind, description.
- **Previous versions**: a list of the 20 newest (time, email, "default" badge). "Load" fetches the body and puts it in the editor, unsaved.
- Leaving the page or switching tabs with unsaved edits asks for confirmation; use a `beforeunload` listener plus the router's blocker, if the app already uses one.
- Non-admins never see the nav item. The route shows the app's existing not-allowed state for them (follow test-record).

- [ ] **Step 1: Failing tests** (stubApi + renderWithProviders, like `ai-call-settings.test.tsx`):
  - It shows the default text and "Using the default".
  - An edit enables Save. Save calls `saveAgentPrompt('instructions', text)` and then shows "Saved — the next call uses it."
  - A 400 shows each problem.
  - Preview shows the rendered text.
  - Reset asks to confirm and then calls `saveAgentPrompt(kind, null)`.
  - The Voicemail tab edits the voicemail kind.
  - "Load" of a version puts its body in the editor without saving.
  - The nav shows "Agent prompt" for an admin only.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the page tests, `npm run typecheck -w apps/outreach-web`, and the full outreach-web suite once → PASS.
- [ ] **Step 5: Commit.** Commit the code as `feat(outreach-web): an "Agent prompt" page to edit, preview, save and reset the agent's instructions and voicemail`, and the runbook as a separate `docs(ai-voice): editing the agent prompt`.
