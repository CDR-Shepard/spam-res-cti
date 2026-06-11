# Caller Reputation CTI

A Salesforce-connected, **manually-dialed** desktop CTI with a built-in
**Caller Reputation Firewall** that gates every call before it's placed.

> This is **not** a power dialer. There is no predictive, parallel, or
> auto-dialing. Every call requires an explicit rep click after the firewall
> returns `ALLOW` (or `REQUIRE_REVIEW` + acknowledgement).

---

## Architecture (MVP)

```
apps/
  cti-web/             Salesforce Open CTI softphone (iframe; served by the API at /cti/*)
  cti-desktop/         Electron + React renderer (hardened preload bridge)
services/
  cti-api/             Fastify backend, Postgres (via Drizzle), Twilio + Salesforce
```

The two frontends share one design system and one component set —
`styles.css`, `icons.tsx`, `format.ts`, `checks.ts`, and `components/*` are
kept byte-identical between `apps/cti-web/src` and
`apps/cti-desktop/src/renderer`. Edit in cti-web, copy to cti-desktop.
Both surfaces show the dialer, the 19-gate firewall verdict, recent calls,
and the per-DID reputation dashboard (Hiya-style 4-axis score), plus a live
org-reputation grade chip in the header.

| Concern              | Choice                                            | Why                                              |
| -------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Backend HTTP         | Fastify                                           | Fast, schema-friendly, tiny ergonomics tax       |
| ORM / migrations     | Drizzle (schema) + plain SQL migrations runner    | Type-safe queries without a heavyweight ORM      |
| DB                   | PostgreSQL (works on Supabase out of the box)     | One connection string, mature, jsonb for audits  |
| Telephony            | **Twilio Voice JS SDK** (Telnyx swappable)        | Fastest path to a working WebRTC call            |
| Salesforce auth      | OAuth 2.0 Auth Code **+ PKCE**, refresh tokens    | No passwords; PKCE for the public desktop client |
| Token storage        | AES-256-GCM at rest (backend), `safeStorage` (client) | Provider/SF refresh tokens never leak to renderer |
| Desktop session      | Opaque token, stored via Electron `safeStorage`   | Keychain-backed when available                   |

### Provider decision

**Twilio first** for MVP because the Voice JS SDK + access token + TwiML App
flow is well-trodden and unblocks an end-to-end call within hours.
`services/cti-api/src/telephony/types.ts` defines a thin provider interface
so Telnyx can drop in once we add a `TelnyxProvider` implementation.

---

## Prerequisites

- Node.js 20.10+
- PostgreSQL (local) or a Supabase project
- A Twilio account with:
  - An Account SID + Auth Token
  - An API Key (SID + Secret) — Console → Account → API Keys
  - A verified outbound number (or owned long code)
  - A TwiML Application whose Voice Request URL points to your backend
    (`${API_PUBLIC_URL}/telephony/twilio/voice`)
- A Salesforce dev org with a Connected App (see below)

---

## First-run setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example services/cti-api/.env
cp .env.example apps/cti-desktop/.env
# Fill TOKEN_ENCRYPTION_KEY, SESSION_SECRET, DATABASE_URL, Twilio + Salesforce values.
# Generate the encryption key:
openssl rand -hex 32

# 3. Create the database (Postgres)
createdb cti_dev   # or use Supabase and paste its connection string into DATABASE_URL

# 4. Apply migrations + seed dev rep
npm run migrate

# 5. Build the Salesforce softphone bundle (the API serves it at /cti/).
#    Required for the Salesforce phone-tab surface; re-run after web changes.
npm run build:web

# 6. Boot the backend
npm run dev:api        # http://localhost:4000  → /healthz should return ok

# 7a. Desktop (macOS) — two terminals: the Vite renderer, then Electron.
npm run dev:desktop                              # terminal A: Vite on :5173
npm --workspace apps/cti-desktop run dev:electron # terminal B: launches Electron

# 7b. Salesforce phone tab — import apps/cti-web/CallCenter.xml
#     (set its adapterUrl to <API_PUBLIC_URL>/cti/), add this CTI as a utility
#     item, and open it from the Lightning utility bar.
```

> Packaging a signed macOS app: `npm --workspace apps/cti-desktop run dist:mac`
> (set `CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`
> to sign & notarize; without them it builds an unsigned local DMG).

**Smoke flow:**

1. Click *Sign in as dev rep* (MVP shortcut; replace with SSO before prod).
2. Open *Settings* → *Connect Salesforce* (system browser opens). Authorize.
3. *Settings* → add your verified Twilio caller ID under *Outbound numbers*.
4. *Settings* → *Test provider connection* should report a valid token.
5. *Dialer* → enter a number → *Check* → review the Firewall verdict.
6. If `ALLOW`, click *Call now*. WebRTC call places via Twilio.
7. Hang up → fill *Disposition* + *Notes* → *Log call + sync to Salesforce*.
8. *Recent calls* shows the call. Within ~5s it should flip to *Synced*.
9. Verify the Task in Salesforce under the matched Lead/Contact.

---

## Salesforce Connected App setup

1. Salesforce Setup → **App Manager** → *New Connected App*.
2. Basic info: any name/email.
3. **Enable OAuth Settings**: ON.
4. **Callback URL**: `${API_PUBLIC_URL}/auth/salesforce/callback`
   (e.g. `http://localhost:4000/auth/salesforce/callback` in dev).
5. **Selected OAuth scopes**: `api`, `refresh_token, offline_access`.
6. **Require Proof Key for Code Exchange (PKCE)**: **ON**.
7. **Require Secret for Web Server Flow**: optional. If ON, set
   `SALESFORCE_CLIENT_SECRET`; if OFF, leave the env var blank — PKCE alone
   authenticates the desktop client.
8. Save. Wait ~5 minutes for changes to propagate.
9. Copy **Consumer Key** → `SALESFORCE_CLIENT_ID` and (if used)
   **Consumer Secret** → `SALESFORCE_CLIENT_SECRET`.
10. For sandbox orgs, set `SALESFORCE_LOGIN_URL=https://test.salesforce.com`.

### Optional custom fields on `Task`

The Salesforce sync writes these custom fields when they exist and gracefully
folds the values into `Description` when they don't (see
`services/cti-api/src/salesforce/client.ts`):

```
External_Call_Id__c        Provider_Call_Id__c        From_Number__c
To_Number__c               Normalized_To_Number__c    Recording_URL__c
Transcript_URL__c          Call_Start_Time__c         Call_End_Time__c
CTI_Provider__c            Consent_Source__c          Consent_Timestamp__c
DNC_Status__c              DNC_Checked_At__c          Opt_Out_Status__c
Precall_Decision__c        Precall_Block_Reason__c    Caller_Reputation_Status__c
Outbound_Caller_ID__c      Campaign_Risk_Score__c     Number_Health_Score__c
```

Create them as Text/URL/Number/DateTime on `Task` as needed.

---

## Twilio TwiML App setup

The renderer dials via the Twilio Voice JS SDK; the SDK posts to the TwiML
Application's *Voice Request URL*. Configure it like so:

- **Voice → Manage → TwiML Apps → Create**
- **Voice Request URL**: `${API_PUBLIC_URL}/telephony/twilio/voice` (POST)
- **Status Callback URL**: `${API_PUBLIC_URL}/telephony/twilio/status` (POST)
  - Events: `initiated, ringing, answered, completed`
- Copy the App SID → `TWILIO_TWIML_APP_SID`.

In dev, expose your backend with a tunnel (e.g. `ngrok http 4000`) and set
`API_PUBLIC_URL` to the public URL so Twilio webhooks reach you. Webhook
signatures are validated against `TWILIO_AUTH_TOKEN`; in `NODE_ENV=production`
invalid signatures return 403.

---

## Caller Reputation Firewall

Every call traverses up to 19 gates (`services/cti-api/src/firewall/index.ts`),
grouped in the UI by what they protect:

**Reputation hygiene** (keeps numbers off "Spam Likely")

| Check               | Severity on fail | Reason codes                              |
| ------------------- | ---------------- | ----------------------------------------- |
| Number warmup cap   | BLOCK            | `NUMBER_WARMUP_LIMIT_EXCEEDED`            |
| Call velocity       | BLOCK            | `CALL_VELOCITY_BURST_DETECTED`            |
| Neighbor spoofing   | REVIEW           | `NEIGHBOR_SPOOFING_RISK`                  |
| Answer rate (per-DID)| REVIEW          | `ANSWER_RATE_BELOW_FLOOR`                 |
| Engagement (sub-6s) | REVIEW           | `ENGAGEMENT_SHORT_DURATION`               |

**Delivery** (will the call actually ring?)

| Check               | Severity on fail | Reason codes                              |
| ------------------- | ---------------- | ----------------------------------------- |
| Outbound # healthy  | BLOCK / REVIEW   | `OUTBOUND_NUMBER_UNHEALTHY`, `…MISSING`   |
| STIR/SHAKEN baseline| BLOCK            | `STIR_SHAKEN_ATTESTATION_DEGRADED`        |

**Compliance** (TCPA / DNC / state law)

| Check               | Severity on fail | Reason codes                              |
| ------------------- | ---------------- | ----------------------------------------- |
| Phone parses        | BLOCK            | `PHONE_INVALID`                           |
| Not opted-out       | BLOCK            | `OPTED_OUT`                               |
| Not on blocklist    | BLOCK            | `BLOCKED_INTERNAL`                        |
| Federal DNC cache   | BLOCK            | `FEDERAL_DNC_LISTED`                      |
| Reassigned number   | BLOCK / REVIEW   | `REASSIGNED_NUMBER_DETECTED`, `…UNCHECKED`|
| Consent record      | REVIEW           | `TCPA_CONSENT_NOT_FOUND`                  |
| Campaign exists     | REVIEW           | `CAMPAIGN_MISSING`                        |
| Campaign not paused | BLOCK            | `CAMPAIGN_PAUSED`                         |
| Attempt limits      | BLOCK            | `ATTEMPT_LIMIT_EXCEEDED`                  |
| Calling hours       | BLOCK / REVIEW   | `OUTSIDE_CALLING_HOURS`, `…UNKNOWN_TZ`    |
| State rules / regs  | BLOCK / REVIEW   | `STATE_RULE_*`                            |
| Recording consent   | REVIEW (two-party) | `RECORDING_CONSENT_REVIEW`              |

When the rep doesn't pin a from-number, the firewall **predicts the rotation
pool's pick** (same selection `POST /calls` makes, see `src/rotation.ts`) so
the per-DID gates — warmup, velocity, neighbor-spoofing, attestation — run at
preflight instead of silently skipping. The verdict shows which caller ID
will carry the call.

Every evaluation persists to `pre_call_audits` (decision, reasons, checks,
request id, audit id). Calls only reference an `auditId` that is ≤ 5 minutes
old and matches the same destination.

The audit row is the evidence: *what we knew, when we knew it, and what we
decided.* It is **not** a legal compliance solution — see *Compliance &
limitations* below.

---

## NumberVerifier reputation feed (real carrier ground truth)

The behavioral gates (warmup, velocity, answer-rate, engagement) are proxies for
"is this DID getting labeled." [NumberVerifier](https://app.numberverifier.com)
monitors each DID's actual **"Spam Likely" / "Scam Likely"** status across
AT&T / Verizon / T-Mobile and POSTs a webhook whenever a number is checked. We
ingest it to drive DID health from **ground truth** instead of a proxy.

**Setup** (one time):

1. Set `NUMBERVERIFIER_VERIFY_KEY` in `services/cti-api/.env` to any strong
   secret.
2. In the NumberVerifier dashboard → **Webhooks**:
   - **Webhook URL** = `${API_PUBLIC_URL}/integrations/numberverifier/webhook`
   - **Verify Key** = the same secret (sent as the `x-verifykey` header)
   - **Version** = `v2` (optionally tick *Only Flagged*)
   - **Send Test Webhook** to confirm a `200`.

**Behavior:** on a flagged result (`flag_status`, or `errors` ∈ {`DNO`, `606`,
`608` → `spam_likely`; `607` → `degraded`}) the matching DID's health flips and
it's pulled from the rotation pool + blocked by the firewall, with an alert and a
`number_health_snapshots` audit row. A later *clean* result auto-restores **only**
numbers NumberVerifier itself paused — never one the behavioral worker or a
live-call analytics block parked (tracked via `outbound_numbers.health_source`).

NumberVerifier replaces the missing Hiya/First Orion/TNS feeds **and** the
reassigned-number (RND) data source. It does **not** cover federal DNC scrubbing
or BCID branded-calling enrollment — those remain separate.

---

## Security posture (MVP)

- **Backend**
  - OAuth refresh tokens + access tokens encrypted at rest with AES-256-GCM.
  - Webhook signature validation on every Twilio webhook; failures recorded
    on `provider_webhook_events`, rejected in production.
  - Webhook inbox table provides idempotency (unique on `provider, external_id`).
  - Salesforce sync is idempotent on `calls.salesforce_task_id` and retries
    with exponential backoff up to 8 attempts.
  - Pino logger redacts `authorization` and `cookie` headers.
  - Strict environment validation on boot (`config.ts`).
- **Desktop**
  - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
  - Single narrow preload bridge (`window.cti`) — renderer cannot see Node.
  - CSP set on every navigation; new windows blocked; external links opened in
    the system browser only.
  - Path validation in the IPC handler refuses `..` and `://` in API paths.
  - Session token encrypted at rest with Electron `safeStorage`
    (Keychain on macOS).
  - No provider/Salesforce secrets ever shipped to the renderer; the desktop
    only sees short-lived Twilio access tokens.

### Known security gaps before hitting production

- No real auth flow yet — `/auth/dev-session` issues a session for the
  seeded user. Wire SSO (Okta/Workspace/Auth0) and remove this endpoint.
- No CSRF protection on POST routes (relies on bearer auth + CORS; fine for
  desktop, lock down before exposing to a web origin).
- No rate limiting; add `@fastify/rate-limit`.
- No code signing / notarization scripts for macOS packaging yet.

---

## Compliance & legal — read before shipping

This product **does not** claim to make you TCPA / DNC / GDPR compliant. It
provides:

- An *internal* opt-out and block list.
- *Per-org* attempt limits and calling-hour windows.
- An audit trail of every pre-call decision.
- Hooks (number health, consent mode) you can wire to real services.

You still need to handle, at minimum:

- **National DNC** (US): integration with iContact/DNC.gov scrubbing or a
  vendor like FreeDNCList.
- **State mini-TCPA** rules (FL, OK, WA, MD, etc.) — call windows, prior
  consent requirements, registration where applicable.
- **Recording consent** — one-party vs two-party state laws; the firewall
  only flags `two_party` campaigns, it doesn't enforce a disclosure prompt.
- **Branded calling / STIR-SHAKEN attestation** — coordinate with Twilio or
  your carrier for B-level attestation and CNAM display.
- **Lead-source consent records** — store prior express written consent
  evidence on the Lead/Contact (`Consent_Source__c`, `Consent_Timestamp__c`).
- **Data residency / GDPR** — DB region selection, deletion endpoints,
  recording retention policy.

A short pre-launch checklist is intentionally **not** included in this repo;
get it reviewed by counsel for the jurisdictions you call into.

---

## What's intentionally **not** in MVP

- Predictive / parallel / auto dialing
- SMS
- AI transcription
- Branded calling API automation
- Full DNC integration
- State mini-TCPA rules engine
- Chrome extension
- Native Swift app
- Multi-tenant admin UI (admin endpoints exist; build the UI on top)
- Refresh-token-driven background Salesforce sync queue worker (it runs
  in-process every 5s — fine for MVP, move to a real queue at scale)

The architecture leaves room for each. See the provider interface
(`telephony/types.ts`) and the sync queue table (`salesforce_sync_jobs`) for
the obvious extension points.

---

## Project layout

```
.
├── apps/
│   ├── cti-web/                        # Salesforce Open CTI softphone (iframe)
│   │   ├── src/
│   │   │   ├── App.tsx                 # shell: header, tabs, call lifecycle
│   │   │   ├── api.ts, opencti.ts, main.tsx
│   │   │   ├── styles.css, icons.tsx   # shared design system (identical in desktop)
│   │   │   ├── format.ts, checks.ts    # phone formatting + firewall gate catalog
│   │   │   └── components/             # shared with desktop, byte-identical
│   │   │       ├── Dialpad.tsx, VerdictPanel.tsx, CallScreen.tsx
│   │   │       ├── WrapupForm.tsx, RecentCalls.tsx, ReputationPanel.tsx
│   │   └── CallCenter.xml              # SF Call Center definition
│   └── cti-desktop/
│       ├── src/
│       │   ├── main/main.ts            # hardened Electron main
│       │   ├── preload/preload.ts      # narrow window.cti bridge
│       │   ├── renderer/               # React + Vite app
│       │   │   ├── App.tsx, state.tsx, api.ts, styles.css
│       │   │   ├── format.ts, checks.ts, icons.tsx, components/   # mirrors cti-web
│       │   │   └── views/{Dialer,Settings,SignIn}View.tsx
│       │   └── shared/ipc.ts
│       └── vite.config.ts
├── services/
│   └── cti-api/
│       ├── src/
│       │   ├── server.ts               # Fastify entry
│       │   ├── config.ts, crypto.ts, phone.ts
│       │   ├── rotation.ts             # shared DID rotation pick (firewall + /calls)
│       │   ├── auth/session.ts
│       │   ├── db/{schema,index,migrate}.ts
│       │   ├── firewall/{index,warmup,tz}.ts   # Caller Reputation Firewall
│       │   ├── routes/{health,auth,firewall,calls,telephony,admin,
│       │   │           reputation,inbound,cti}.ts
│       │   ├── salesforce/{oauth,client,sync}.ts
│       │   └── telephony/{types,twilio,index}.ts
│       ├── migrations/0001…0006
│       └── drizzle.config.ts
└── README.md, .env.example, SPAM_RESISTANCE_2026.md, FIREWALL-GAP-AUDIT.md
```

---

## Day-2: what to wire next

1. Replace `/auth/dev-session` with SSO.
2. Real DNC scrub provider as an extra firewall check.
3. Pull lead/contact timezone from Salesforce in `findByPhone` and store in
   `call_targets.timezone` to make calling-hours checks deterministic.
4. Number health: nightly poll FreeCallerRegistry / Hiya status into
   `number_health_snapshots`.
5. Move the in-process Salesforce sync loop into a queue worker once volume
   grows past a few req/s.
6. Add `electron-builder` config to package and notarize the macOS app.
7. Add E2E coverage of the firewall + call lifecycle with a mocked provider.
