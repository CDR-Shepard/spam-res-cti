# AI Outreach Platform — Program Design

**Date:** 2026-09-03
**Status:** Approved program design. Sub-project 1 (Foundation) has its own spec: [2026-09-03-outreach-foundation-design.md](./2026-09-03-outreach-foundation-design.md).
**Scope of this document:** the decisions that span every sub-project, the architecture they share, and the decomposition into build cycles. Each sub-project gets its own spec, plan, and implementation cycle.

---

## 1. What we are building

A multi-tenant outbound platform for cash homebuyers. Tenants load owner lists (pre-foreclosure, absentee, probate, tax-delinquent, and similar), and the platform works them across voice, SMS, and email. Cold first touches are placed by the platform under the compliance rules below. The moment a homeowner engages — replies to a text or email, calls back, or picks up a screened cold call — an AI agent or a human agent takes the conversation. When the AI decides a homeowner is a real, interested seller, that person reaches a human agent by live bridge (voice) or by a pinged, claimable thread in a shared inbox (text and email), and a lead is created in the tenant's CRM.

The positioning against Artisan.co: Artisan is an email-first AI SDR for B2B. This is a phone-first, compliance-native AI outreach system for the most regulated outbound vertical there is, built on a caller-reputation and firewall substrate that already exists in this repository.

**Customer one** is GG Homes (our own operation). It is the design partner and the first tenant, not a special case in the code.

---

## 2. Decisions locked during brainstorming

| Topic | Decision |
|---|---|
| Audience | Multi-tenant product from day one. Our operation is tenant one. |
| Channels | Voice, SMS, and email. All three ship, in the order given in §5. |
| Cold voice | **Silent human screen, instant bridge.** No synthetic voice is ever played on a cold call. A streaming classifier decides human vs. machine after pickup and the call bridges to the next free agent with an AI-prepared screen-pop. Same legal footing as the existing power dialer. |
| Cold SMS | **AI sends cold texts directly on registered 10DLC.** Risk was raised (carrier filtering of unsolicited A2P traffic; FL/OK/WA/MD mini-TCPAs) and accepted. Mitigations are mandatory: a per-tenant switch to human-click mode, hard BLOCK for the four mini-TCPA states without a consent record, per-number daily send caps, recipient-local quiet hours, instant STOP handling, and carrier-filter telemetry surfaced as number burn. |
| Cold email | AI sends. CAN-SPAM is opt-out based; identification and unsubscribe are enforced in the sender. Deliverability is the engineering problem. |
| AI conversation | Owns every thread after the homeowner engages, on any channel, until a human claims it. |
| AI voice | Inbound answering, and outbound only to numbers with a consent record. Encoded as a firewall gate (`ai_voice_consent`) so no feature can route around it. |
| Lead store | **Hybrid.** Cold contacts live only in the platform. A qualified homeowner becomes a lead in the tenant's CRM, which owns the relationship from then on. |
| CRM delivery | Generic signed webhook with a versioned payload, plus native adapters. Salesforce first. |
| Handoff | Voice: live bridge into the pooled agent conference. Text and email: shared inbox; an agent is pinged, claims or is assigned the thread, and takes over typing. Fallback when no agent is free: the AI books a slot on an agent's calendar. |
| Architecture | **Approach C.** One monorepo (`spam-res-cti`), one Postgres, shared packages extracted from `cti-api`, separate deployables on the same Railway project. See §4. |

---

## 3. Compliance posture

This section records the constraints the design encodes. It is not legal advice; counsel reviews before launch in each jurisdiction called or texted into.

- **Artificial or prerecorded voice.** The FCC's February 2024 declaratory ruling treats AI-generated voice as artificial voice under the TCPA. That prong applies independently of autodialer status. Any synthetic speech to a cell phone — including a one-line greeting or a "please hold" — requires prior express consent (prior express *written* consent where the call is telemarketing). Therefore: cold voice never plays synthetic audio; AI voice is inbound or consented-outbound only; the firewall blocks AI-actor voice to any destination without a consent record.
- **Autodialer.** After *Facebook v. Duguid* (2021) the federal ATDS definition requires random or sequential number generation. Dialing or texting from a stored list is not federal ATDS use. State mini-TCPAs (Florida FTSA, Oklahoma, Washington, Maryland, and others) define automated systems more broadly and impose per-day contact caps and calling windows. The firewall's state rules already model several of these for voice; they extend to SMS.
- **Consent rule status.** The FCC's one-to-one consent rule was vacated (Eleventh Circuit, January 2025). The underlying consent requirements for artificial voice and for telemarketing remain.
- **DNC.** Federal DNC scrubbing, internal opt-outs, and the block list apply to every outbound channel. A STOP on any channel is an opt-out for every channel.
- **10DLC / CTIA.** Carriers expect opt-in consent for A2P messaging and filter unsolicited marketing regardless of statute. The platform registers brands and campaigns per tenant, monitors filtering error codes, and rotates and retires numbers on evidence.
- **Recording consent.** All-party states require disclosure. Existing campaign-level `recording_consent_mode` behavior carries forward; AI voice calls disclose recording where required.
- **Bot disclosure.** California's BOT Act and similar statutes require disclosure that a homeowner is talking to an automated agent in commercial contexts. The AI discloses when asked and where a tenant's jurisdiction settings require it proactively.
- **Attempt ceilings count across channels.** Florida's three-per-24-hours cap counts calls and texts together. The firewall's attempt gates read a cross-channel view.
- **Litigator scrub.** Known TCPA litigators are scrubbed at import and blocked at the firewall.

---

## 4. Architecture

```
spam-res-cti/
├── packages/
│   ├── db/            schema, connection, migration runner (advisory-locked), migrations/
│   ├── firewall/      one file per gate + aggregator; state rules, warmup, tz, rotation
│   ├── phone/         normalization, libphonenumber wrapper
│   ├── auth/          session issue/resolve, WorkOS exchange, token encryption
│   ├── salesforce/    REST client + OAuth helpers (workers stay in cti-api)
│   └── contracts/     zod schemas shared by APIs and web (webhook payloads, API DTOs)
├── services/
│   ├── cti-api/       unchanged role: softphone, Twilio webhooks, SF sync, power dialer
│   ├── outreach-api/  product API: tenants, lists, contacts, suppression, delivery,
│   │                  campaigns, threads; serves outreach-web; runs pg-boss handlers
│   └── ai-worker/     (sub-project 2) conversation turns, classification, summaries
├── apps/
│   ├── cti-web/       Salesforce Open CTI softphone (unchanged)
│   ├── cti-desktop/   Electron (unchanged)
│   ├── cti-ios/       Callsign (unchanged)
│   └── outreach-web/  product web app: React 18 + Vite, TanStack Router/Query, Tailwind, shadcn/ui
└── salesforce/        unchanged
```

**One database.** Compliance state — opt-outs, block list, DNC cache, consent records, litigator entries, attempt counts, pre-call audits — is shared by construction between the reps' softphone and the AI outreach. This is the reason for Approach C over a separate repo: this state cannot be eventually consistent.

**Deployables** are separate Railway services in project `endearing-comfort`, each with its own Dockerfile and `railway.json`, all bound to the same Postgres. The migration runner takes a Postgres advisory lock so concurrent pre-deploy runs serialize.

**Jobs** run on pg-boss in the shared database. New asynchronous work (imports, scrubs, deliveries, AI turns, sends) is a job with retries, backoff, and dead-lettering. Existing `cti-api` interval loops are left alone.

**Identity vs. integration.** Salesforce as a rep identity (softphone OAuth) and Salesforce as a CRM delivery target are separate concerns with separate connections.

---

## 5. Sub-projects and order

Each row is one spec → plan → implementation cycle.

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| 1 | **Foundation** | Package extraction; real tenancy and auth (WorkOS AuthKit); lead store; import pipeline with dedupe and scrub; litigator table and gate; channel- and actor-aware firewall; cross-channel attempt view; `ai_voice_consent` gate; CRM delivery outbox with signed webhook and Salesforce adapter; manual "mark qualified"; admin web app for lists, contacts, suppression, connections, team. | — |
| 2 | **SMS + AI thread engine + inbox** | Per-tenant 10DLC brand/campaign registration; SMS number pool (new `outbound_numbers.kind`) with warmup and rotation; campaigns and cadences over list memberships; AI opener generation with content variation; SMS firewall gates (registered campaign, mobile line type, texting quiet hours, per-number daily cap, state SMS rules); inbound webhook → thread; STOP/HELP; the conversation engine (Claude with tools: record qualification, request handoff, book slot, opt out, escalate, look up property); per-tenant qualification rubric and persona; shared inbox with AI/human thread state, ping (web push, Slack, SMS to agent), claim/assign, takeover, AI-suggested replies; `lead.qualified` emitted by the AI; carrier-filter telemetry and number-burn dashboard; `ai-worker` deployable. | 1 |
| 3 | **Cold voice: pooled agent bridge** | Evolve the dialer engine to run from platform lists; agent presence and pooled routing (longest idle); sub-second silent screen on Twilio Media Streams with a streaming classifier, Twilio AMD as fallback; bridge into the agent's conference; screen-pop and agent softphone in `outreach-web` (reusing softphone components); dispositions; optional dial ratio above 1.0 per tenant with abandonment tracking, default off; post-call AI: transcription, summary, disposition suggestion, follow-up scheduling, and SMS thread takeover once consent is captured on the call. | 1 (post-call AI needs 2) |
| 4 | **AI voice** | Inbound answering on tenant DIDs (always or after-hours, per tenant); callbacks to consented leads only; Retell or Vapi as the conversational media layer with our prompts and tools; warm transfer into the agent pool via the conference bridge; voicemail handling; recording disclosure; `ai_voice_consent` enforced at origination. | 2, 3 |
| 5 | **Email** | Sending domains and DNS setup; mailbox warmup (build or integrate); sequences; inbound parsing into the thread engine; unsubscribe and CAN-SPAM footer; bounce and complaint handling; deliverability dashboard. | 2 |
| 6 | **Analytics and billing** | Per-tenant funnel (list → contacted → engaged → qualified → delivered → closed via CRM callback); agent performance; number health rollups; Stripe billing per seat plus usage. | 2–5 |

Sub-project 2 is where the product gets its identity. Sub-project 3 is mostly evolving what already exists.

---

## 6. Explicitly out of scope for the program right now

- Predictive dialing beyond a small, tracked dial ratio.
- Skip tracing and property data enrichment integrations (schema leaves room).
- Selling the firewall as standalone middleware (Approach C does not prevent it).
- SCIM, fine-grained roles, SOC 2 tooling.
- Non-US jurisdictions.

---

## 7. Glossary

- **Tenant / org:** one customer; the existing `organizations` row.
- **Person:** an owner or decision-maker. **Property:** a real property. **Contact point:** one phone or email.
- **Actor:** who initiated an action, `human` or `ai`. Every AI action is attributed to the tenant's "AI Agent" service user.
- **Touch / attempt:** one outbound contact on any channel, counted by the firewall.
- **Qualification:** the recorded moment a person becomes a lead. **Delivery:** pushing that lead to a CRM connection.
- **Handoff:** moving a live homeowner from AI to human (bridge, claim, or booking).
