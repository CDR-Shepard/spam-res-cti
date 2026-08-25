# iPhone Caller-ID App (Call Directory) — Design

**Date:** 2026-08-25 · **Approved by:** Evren (section-by-section)
**Goal:** When an inbound call forwards to a rep's iPhone, the native incoming-call screen shows who it is from Salesforce — `Deal: 123 Main St`, `Opp: 456 Oak Ave`, or `Lead: Jane Doe` — with no change to how calls are routed.

## Decisions (locked, with the user)

| Decision | Ruling |
|---|---|
| Approach | **Call Directory extension** (thin labeling app; calls stay on cellular forwarding). The full VoIP/CallKit softphone stays parked as the someday-app (original note #7). |
| Scope of numbers | Leads (Phone/Mobile), Opportunities (primary contact + tied Account phones), Deals (`Deal__c` phone fields — reuse `findByPhone`'s field knowledge) |
| Per-number precedence | **Deal > Opp > Lead** (latest stage wins) |
| Label format | Stage prefix + the record's **Name field verbatim**: `Deal: <Deal__c.Name>` / `Opp: <Opportunity.Name>` / `Lead: <Lead.Name>` (user default; person-name variant is a one-line change) |
| Apple account | Exists (GG Homes has an Apple Developer Program membership); distribution via TestFlight to the 12 reps |
| App sign-in | 6-digit pairing code generated in the authenticated softphone → long-lived device token (existing session machinery); revocable per device |
| Freshness | Server snapshot rebuilt every 30 min (versioned, paged, `changedSince` cursor); phones refresh on iOS background refresh + a silent push when the version bumps; worst-case staleness ~30–60 min. Known gap (accepted): a lead created minutes before calling shows unlabeled until the next cycle |
| App-less stopgaps (whisper / SMS heads-up) | Offered; **not chosen** — on-screen was the requirement |

## Server (services/cti-api)

1. **Snapshot builder** (worker, every 30 min, per org): SOQL sweeps of Lead / Opportunity(+primary contact role, Account) / `Deal__c`; normalize every phone via `phone.ts`; dedupe by E.164 with Deal > Opp > Lead; entries `{ e164, label }`, label prefix per stage. Persisted (table `caller_directory_entries` + a `caller_directory_versions` row per build) so serving is DB-only.
2. **Feed**: `GET /mobile/caller-directory?since=<version>&page=` — device-token auth; returns `{ version, complete | changes }` pages sorted by number (Call Directory wants ascending inserts). Full snapshot on first sync, incremental after.
3. **Pairing**: `POST /mobile/pair/start` (softphone session → 6-digit code, 5-min TTL) and `POST /mobile/pair/claim` (code → device token, stored like sessions with a device label); `DELETE` to revoke. Softphone gets a small "Pair your iPhone" card that shows the code.
4. **Silent push nudge**: on a new version, send a background push (APNs token registered by the app) telling paired devices to refresh + `reloadExtension`. Best-effort — background refresh is the backstop.

## iPhone app (apps/cti-ios)

- SwiftUI app + **Call Directory extension** sharing an App Group container. One screen: pairing (enter code), sync status (entry count, version, last refresh), and a guided "enable in Settings → Phone → Call Blocking & Identification" helper with a live enabled/disabled check (`CXCallDirectoryManager.getEnabledStatus`).
- Sync engine: pulls the feed into the shared container (SQLite/flat file), then `reloadExtension()`; the extension streams entries ascending via `addIdentificationEntry`. Background refresh task + silent-push handler do the same headlessly.
- Pure logic (feed paging, merge, ascending-order invariant) unit-tested; UI minimal.

## Rollout & acceptance

- Built and verified on the iOS Simulator on this machine (simulated incoming-call labeling + unit tests both sides). TestFlight signing/upload = the user's one-time step with a prepared click-by-click.
- Reps: install → enter code → flip the one Settings switch.
- Acceptance: a live call from the owned test DID to a paired iPhone shows a `Lead:`-prefixed label on the native call screen; the fleet's own DIDs may also be labeled (`GGH: <label>`) as a stretch so reps recognize internal calls — decide at plan time, default OFF.

## Out of scope

The VoIP/CallKit softphone app; Android; whisper/SMS stopgaps (declined); real-time (<30 min) label freshness.
