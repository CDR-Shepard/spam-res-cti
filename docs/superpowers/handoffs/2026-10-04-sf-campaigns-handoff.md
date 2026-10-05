# Handoff: Salesforce campaigns (phase 1) — 2026-10-04

The agent that wrote the spec and plans ran out of usage. This file has everything a new agent needs to continue. Read it all before doing anything.

## What we are building

GG Homes is a cash homebuyer that runs on Salesforce. They want an outreach product that works like Convoso plus Artisan.co. A user drops in a Salesforce list view or a pasted SOQL query of Leads or Opportunities. The system works through those records and contacts each person by phone, SMS, or email. AI reads the notes on each record to pick the channel. AI voice is used only when the record's consent checkbox is ticked.

- **Spec (approved by the user):** `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md`
- **Phases:**
  1. Salesforce campaigns, AI triage, and calls that a rep takes through the existing CTI power dialer. **This handoff covers phase 1.**
  2. SMS and the inbox.
  3. Email.
  4. AI voice.

Phase 1 is split into two plans:

| Plan | File | Tasks | What it ships |
|---|---|---|---|
| 1A, dry run | `docs/superpowers/plans/2026-10-04-sf-campaigns-1a-dry-run.md` | 13 | `@cti/salesforce` package, firewall moves, migration 0050, contracts, SF connection, campaign source/preview, campaigns routes, refresh/enroll ticks, planner, AI triage (Haiku 4.5), Needs Review, outreach-web campaign screens. Nothing is sent. Touches are planned only. |
| 1B, live calls | `docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md` | 8 | SF consent fields and permission set, SF write-back outbox (`sf_writes`), consent capture and backfill, campaign calls through the CTI dialer, the cti-web picker, `calls.reconcile`, kill switch and auto-pause alerts, deploy and runbook. |

Each plan begins with Global Constraints, Plan-level refinements (numbered 1–15), and "Decisions made while writing the tasks". **Those sections override the spec wherever the two differ.** Every task starts with a "Before you start" note that lists what it depends on.

## Where things are

- **Repo:** `/Users/cdrshepard/spam-res-cti` (GitHub `CDR-Shepard/spam-res-cti`).
  - npm workspaces, TypeScript 5.6 strict, ESM with `.js` import suffixes.
  - Fastify 4, Drizzle 0.36.4 (pinned), zod 3, pg-boss 12.30.
  - Tests: vitest 2 for Node; vitest 4 with jsdom for web.
  - Web: React 18, TanStack Router and Query, Tailwind 4, shadcn.
- **Plans branch:** `docs/outreach-salesforce-campaigns-spec`, in worktree `/Users/cdrshepard/spam-res-cti/.worktrees/sf-campaigns-spec`. It branches off `origin/main` at `fa78987`. It holds the spec, both plans, the 1B source drafts (`docs/superpowers/plans/sf-campaigns-1b-drafts/`, kept only for reference), and this file.
- **Shared checkout `/Users/cdrshepard/spam-res-cti`:** it is on `feat/outreach-product-skeleton`, and a peer Claude session (Callsign / dialer work) also uses it. **Do not run git checkout, switch, reset, or stash there, and never move `main` there.** Do all work in a worktree under `.worktrees/`.
- **The outreach product so far:** plan 2 is on `main` (`f5be12e`). It is the `apps/outreach-api` and `apps/outreach-web` skeleton with WorkOS and the Railway IaC (`.railway/railway.ts`). Plan 1 (tenant slug `gg-homes`) was deployed on 2026-09-04. The `outreach-api` Railway service **has not been created yet**; `docs/runbooks/outreach-api-deploy.md` covers that operator step.
- **Railway:** project `endearing-comfort`, managed by `.railway/railway.ts`. The old `railway.json` path is deprecated, with a 2026-12-01 cutoff.
- **Pending IaC fix:** branch `fix/outreach-iac-preserve-ios-push`, rebased onto `origin/main` as `9a71bd0` in worktree `.worktrees/iac-fix`. Without it, `railway config apply` would delete `@cti/api`'s `TWILIO_IOS_PUSH_CREDENTIAL_SID`. The user has to push it (see below).

## Standing rules (from the user; do not break them)

1. **The user runs every `git push`.** The permission classifier blocks the agent from pushing. Give the user the exact command.
2. **Never run `railway config apply`.** It is the user's step. Before any apply, re-run `railway config plan`. **Stop if the plan shows any `- Delete variable` line.**
3. **Never print `DATABASE_PUBLIC_URL`** or any other secret value.
4. **Don't touch `.superpowers/sdd/progress.md`.** It is the peer session's ledger. Make your own, e.g. `.superpowers/sdd/progress-sf-campaigns.md`.
5. **Never stage `.claude/launch.json` or `apps/cti-ios/App/CTICallerID.entitlements`.** Always stage explicit paths; never use `git add -A` or `git add .`.
6. **Commit format:** `<type>(<scope>): <description>`, with no `Co-Authored-By` trailer. The user's global settings turn attribution off.
7. **The user decides quickly and takes the recommended option.** Lead with a recommendation. Ask only when the decision really is theirs.

## Decisions already locked (don't reopen)

- **AI voice:** only when the Salesforce checkbox `AI_Call_Consent__c` is true. Otherwise the call goes to a rep through the CTI power dialer: a silent screen, then a bridge.
- **Consent fields:** `AI_Call_Consent__c`, `AI_Call_Consent_Date__c`, and `AI_Call_Consent_Source__c`. Source is a picklist: Text Reply, Email Reply, Web Form, Inbound Call, Rep. Any of those sources may tick the box.
- **Campaigns:** a list view or pasted SOQL, run as an always-on sequence of 6 touches over 14 days, on days {0,1,3,6,10,14}.
  - Refresh every 240 minutes.
  - Cap: 50,000 members. Salesforce batches of 200.
  - The preview examines the first 2,000 members.
- **AI:** qualifies the person, then hands off to the record owner.
  - Triage uses `claude-haiku-4-5-20251001` through `@anthropic-ai/sdk` ^0.131.0.
  - Input is capped at 8,000 characters and includes the last 10 Tasks.
  - Default AI budget is $25/day.
  - When AI is on, the planner waits for triage, for at most 24 hours.
- **Contact rules:**
  - Hours (recipient's local time): calls 08:00–21:00, texts 09:00–20:00, email 08:00–18:00.
  - At most one touch per person per day.
  - A CTI dial in the last 24 hours defers the touch.
  - A person can be in only one active campaign, keyed on E.164 phone and on email (partial unique index).
- **Jobs:** pg-boss scheduled ticks over rows claimed in the database. Queues use `policy: 'stately'` (`TICK_QUEUE_OPTIONS`); a queue's policy can't change after it is created.
- **Touch statuses:** planned / held / queued / dialing / sent / failed / skipped.
- **Salesforce connection:**
  - Connect with a full-license Salesforce user. The Integration license is API-only and can't be used. Client credentials is a later follow-up.
  - Only a `SalesforceAuthError` marks a connection broken; an outage does not.
  - `@cti/salesforce` is a new package. The CTI keeps its own Salesforce client because 35 files import it.
- **Email (phase 3):** separate outreach domains on Google Workspace, with the inbox in outreach-web. The stack is our own: Claude, Twilio, Gmail API, the CTI dialer, and Twilio ConversationRelay for phase 4.

## Next steps, in order

### 1. Get the user to push (first thing)

```bash
git -C /Users/cdrshepard/spam-res-cti push -u origin docs/outreach-salesforce-campaigns-spec
```

```bash
git -C /Users/cdrshepard/spam-res-cti/.worktrees/iac-fix push origin fix/outreach-iac-preserve-ios-push:main
```

If the second push is rejected because `main` moved, run `git -C .worktrees/iac-fix rebase origin/main` and push again.

### 2. Review plan 1B before executing it

Plan 1B was assembled from two drafts. The B5–B8 drafter was stopped while doing a final self-check. Its last stated step was switching B7's alerts to B2's `(orgId, text)` shape. The assembled plan already appears to use that shape: `OrgAlert` and `campaignsPausedAlert` in Task 7. Run one review pass over plan 1B against the spec and plan 1A's Interfaces blocks. Check these seams:

- **Task 6 (`calls.reconcile`):**
  - Touches whose record the dialer build gated (consent, opt-out, DNC, Skip on Dialer) settle as `skipped`.
  - Records the build dropped from the run are handled.
  - A run that ended with nothing settled is released back to `queued`.
- **Task 7:**
  - Every alert uses `(orgId: string, message: string) => Promise<void>`.
  - `ai_budget` pauses auto-resume to `campaigns.paused_from`.
  - `crm_broken` pauses never auto-resume.
  - The 24-hour outbox alert is B2's `sfWriteAlert` (kind `sf_write_failing`), not a second one.
- **Tasks 2 and 6:** the `sf.write` and `calls.reconcile` queues reuse `TICK_QUEUE_OPTIONS` from 1A's `src/jobs/queues.ts`.
- **Task 8:** it appends to `docs/runbooks/outreach-sf-campaigns.md` (which Task 1 creates). It also fixes the `WORKOS_REDIRECT_URI` line in `.env.example`.
- **Names:** every name a 1B task "consumes" from 1A must exist in 1A with the same signature. Plan 1A's "Decisions made while writing the tasks" lists 1A's renames, e.g. the error code `salesforce_disabled` (not `disabled`), `paused_from`, `waitForTriage`, and `markBroken` firing only on `SalesforceAuthError`.

Fix problems in the plan file and commit them on the plans branch. If you change a draft task, re-run the assembler. Usage: `assemble.py` in `sf-campaigns-1b-drafts/`, via `assemble(header, order, drafts, out, intro_sections)`, with order B1…B8. Then replace "Skeleton corrections" with "Decisions from drafting". Editing the assembled plan directly is simpler and fine.

### 3. Ask the user to review both plans

Keep it short: one paragraph per plan, plus anything the review in step 2 changed. They usually answer "looks right".

### 4. Execute plan 1A, then 1B

Use **superpowers:subagent-driven-development**: a fresh implementer per task, then spec review and code review.

1. Create an implementation worktree off `origin/main` after step 1's pushes land, e.g. `.worktrees/sf-campaigns` on branch `feat/outreach-sf-campaigns`. Bring in the plans: merge the plans branch, or read the plans from the plans worktree.
2. Extract each task brief with the skill's `task-brief` script, e.g. `task-brief <plan> <N> <out>`. Headings are `### Task N: … [A3]`, and extraction of both plans has been tested.
3. Keep a ledger in `.superpowers/sdd/progress-sf-campaigns.md`.
4. Task 3 of 1A adds a real-Postgres test lane; follow its setup notes.
5. After each plan, run the whole suite: `npm test` and the typechecks for every workspace the plan touched. Then give the user the push command.
6. Plan 1A ships safely on its own (dry run, nothing sent). Plan 1B goes live only after the operator steps below.

## Operator steps only the user can do

Track these with the user. None of them blocks writing plan 1A's code.

1. **Push the plans branch and the IaC fix** (step 1). Then run `railway config plan` again and apply only if no variable is deleted.
2. **Deploy `outreach-api`** per `docs/runbooks/outreach-api-deploy.md` and finish the WorkOS setup.
3. **Retire `railway.json` before 2026-12-01** (runbook §5).
4. **Salesforce:**
   - Create a full-license integration user.
   - Deploy the consent fields and the `AI_Outreach` permission set (plan 1B Task 1 runbook).
   - Authorize the Salesforce connector in claude.ai connector settings, so agents can query the org.
5. **Anthropic API key** for outreach-api, used for triage.
6. **Confirm the web forms' consent language**, which the Web Form consent source relies on.
7. **For phases 2 and 3:**
   - Start Twilio 10DLC registration.
   - Buy the outreach domains and Google Workspace mailboxes, and start warm-up.
   - Subscribe to a litigator list.

## Memory

The previous agent's notes are in `/Users/cdrshepard/.claude/projects/-Users-cdrshepard-outreach-agent/memory/` (`MEMORY.md` and the two files it links). They hold the user profile and project history. They belong to the other account's setup, so copy the useful parts if the new agent keeps its own memory.
