# Power Dial LWC — Setup Guide

**Status: code complete (Apex relay + LWC + CTI API endpoints + web poll),
but NOT deployed and NOT wired in any org.** Deploying this, creating the
Named Credential and shared secret, setting `HANDOFF_SHARED_SECRET` in
Railway, and wiring the List Button + Flow are all separate, **user-gated**
steps — nobody has done any of them yet. Follow this guide in order.

This folder is the Salesforce (Lightning Web Component) half of the Power
Dialer handoff: it collects a set of Lead/Opportunity record ids and, via
the `PowerDialRelay` Apex class (`../../classes/PowerDialRelay.cls`), POSTs
them to the CTI API's handoff relay endpoint. The already-signed-in CTI
softphone running in `apps/cti-web` (served by `services/cti-api` at `/cti/`
and loaded as a Lightning utility item — see the repo root `README.md`,
"Salesforce phone tab") polls for and picks up the handoff on its own, then
auto-starts the Power Dial run. See `docs/superpowers/plans/2026-07-14-power-dialer-5-handoff-relay.md`
for the full design.

---

## 0. Is there a Salesforce DX project yet?

No. At the time this was written, this repo has no `sfdx-project.json`
anywhere and no other `force-app/` tree — this component's folder is the
first Salesforce DX metadata in the repo. Before `sf project deploy start`
will work, you need a minimal `sfdx-project.json`, e.g. at
`salesforce/sfdx-project.json`:

```json
{
  "packageDirectories": [
    { "path": "force-app", "default": true }
  ],
  "namespace": "",
  "sourceApiVersion": "60.0"
}
```

That file is intentionally **not** created by this task (it has org-shaped
implications — default package directory layout, source-tracking behavior —
that should be a deliberate choice, not a side effect of a metadata scaffold
commit). Add it yourself, or ask for it explicitly, before deploying.

## 1. Deploy

Once `sfdx-project.json` exists, deploy the LWC together with the Apex
relay and the custom setting it depends on (the LWC won't resolve
`@salesforce/apex/PowerDialRelay.sendToCti` if the class isn't deployed
first/alongside it):

```bash
cd salesforce   # the directory containing sfdx-project.json
sf org login web -a myorg          # if not already authenticated
sf project deploy start -o myorg -d \
  force-app/main/default/objects/Power_Dial_Setting__c \
  force-app/main/default/classes/PowerDialRelay.cls \
  force-app/main/default/classes/PowerDialRelay.cls-meta.xml \
  force-app/main/default/classes/PowerDialRelayTest.cls \
  force-app/main/default/classes/PowerDialRelayTest.cls-meta.xml \
  force-app/main/default/lwc/powerDial
```

(Or just `sf project deploy start -o myorg -d force-app` to deploy
everything in the package at once, once you're comfortable with the whole
tree.) This is a **user-gated step** — nobody has run this deploy yet.

## 2. Files involved

| File | Purpose |
|---|---|
| `powerDial.js` | Resolves the object type + record id(s) and calls `PowerDialRelay.sendToCti` (Apex). |
| `powerDial.html` | A "Power Dial (N)" button + a status line. |
| `powerDial.js-meta.xml` | `apiVersion` 60.0, `isExposed`, and four targets (below). |
| `README.md` | This file. |
| `../../classes/PowerDialRelay.cls` | `@AuraEnabled sendToCti(objectApiName, recordIds)` — POSTs the selection to the CTI API's handoff relay via the `CTI_PowerDial` Named Credential. |
| `../../classes/PowerDialRelayTest.cls` | `HttpCalloutMock`-based unit tests (Salesforce requires ≥1 test class per deployed Apex class in a production org). |
| `../../objects/Power_Dial_Setting__c/` | A **Protected, Hierarchy Custom Setting** holding the `Handoff_Shared_Secret__c` field — the org-side half of the shared secret. Its metadata (object + field) is deployed as code; the secret **value** is entered manually in Setup (§3, below) and never committed. |

## 3. Named Credential + shared secret setup (user-gated)

The relay authenticates to `services/cti-api`'s `POST /dialer/handoffs`
with a shared secret sent as the `x-handoff-secret` header — the same
value must be configured on **both** sides (Salesforce and Railway). This
is the part of the setup with real security consequences, so do it
carefully and don't skip straight to "just deploy and see":

1. **Generate a secret.** Anything long and random works, e.g.
   `openssl rand -hex 32`. `HANDOFF_SHARED_SECRET` on the CTI API side is
   validated `min(16)` characters (`services/cti-api/src/config.ts`) — use
   something well above that floor.

2. **Create the Named Credential** (Setup → Named Credentials → New Named
   Credential, or the newer "New Legacy Named Credential" depending on org
   version):
   - Label / Name: `CTI_PowerDial` (the Apex callout endpoint,
     `callout:CTI_PowerDial/dialer/handoffs`, must match this exact API
     name).
   - URL: the CTI API's base URL — e.g.
     `https://ctiapi-production.up.railway.app` (no trailing slash; Apex
     appends `/dialer/handoffs`).
   - Identity Type: **Anonymous** (auth is the `x-handoff-secret` header,
     not Named-Credential-managed OAuth/Basic — Anonymous is correct here
     since PowerDialRelay sets the header itself).
   - Generate Authorization Header: **unchecked** (again, auth is the
     custom header, not Named Credential auth).
   - Allow Merge Fields in HTTP Header: not required for this class as
     written (the header value comes from Apex, not a Named Credential
     merge field), but harmless to enable if you prefer to manage the
     secret as a Named Principal header instead of the custom setting
     below — that's a reasonable alternative; just also update
     `PowerDialRelay.getHandoffSharedSecret()` to stop reading the custom
     setting if you do.

3. **Store the secret on the Salesforce side** — via the
   `Power_Dial_Setting__c` Hierarchy Custom Setting deployed in §1:
   Setup → Custom Settings → **Power Dial Setting** → Manage → **New**
   (this creates the *org-wide default* row; leave the "Location" field at
   its default). Paste the secret from step 1 into
   **Handoff Shared Secret**. Save.
   - This is a manual, org-side data-entry step — Custom Setting *values*
     are org data, not deployable metadata, and must never be committed to
     source control. Only the Custom Setting's shape (object + field) is
     code (`../../objects/Power_Dial_Setting__c/`).
   - Because the setting is **Protected**, it isn't visible to other
     packages/namespaces, but any admin can still manage its data via
     Setup as above (Protected restricts packaging visibility, not
     admin access, in an unmanaged/unpackaged org like this one).

4. **Set the same secret in Railway** — the CTI API's `HANDOFF_SHARED_SECRET`
   environment variable, on the `ctiapi` service, must be set to the
   **exact same value**. Until this is set, `POST /dialer/handoffs` returns
   `503` (feature disabled) unconditionally — see
   `services/cti-api/src/routes/dialer.ts`. This is also user-gated: no one
   has set this variable yet.

5. **Verify:** click Power Dial in the org (once wired per §4 below) and
   confirm the CTI softphone auto-starts the run within ~5s (the web app's
   poll interval, `apps/cti-web/src/App.tsx`). If it returns 401, the two
   secrets don't match. If it returns 503, `HANDOFF_SHARED_SECRET` isn't
   set in Railway yet.

## 4. Targets — what each one is actually good for

`powerDial.js-meta.xml` exposes four targets. They are **not** equally
useful for the real "select several list-view rows and dial them" use case
— this is called out explicitly because it's easy to assume
`lightning__RecordAction` covers list views, and it doesn't:

### `lightning__RecordAction` — single-record Quick Action only

This is a genuine, documented target for a Lightning Web Component quick
action (`actionType: ScreenAction`), addable to a Lead or Opportunity
**record page** via Setup → Object Manager → *[Object]* → Buttons, Links,
and Actions → New Action. Salesforce auto-injects `@api recordId` for the
one record you're on.

**It does not receive a list-view selection.** Per Salesforce's own Lightning
Web Components documentation, LWC-based quick actions work "on record pages
only" — there is no supported way for a raw LWC quick action to receive
multiple selected ids from a list view. (Confirmed against
`developer.salesforce.com/docs/platform/lwc/guide/use-config-for-quick-actions.html`
as of this writing.) Use this target only for a "Power Dial this one record"
button on a record page, not for bulk dialing.

One thing to verify in-org: it's not confirmed here whether Salesforce
auto-populates `@api objectApiName` in the `lightning__RecordAction` context
the way it does for `lightning__RecordPage`. If it doesn't come through
empty in testing, you'll need a per-object wrapper or a small code change to
hardcode it.

### `lightning__FlowScreen` — the realistic list-view path

This is the actual supported mechanism for "select several list-view rows,
then dial them": embed this component as a screen in a **Screen Flow**, and
launch that flow from a **List Button** on the Lead/Opportunity list view
that passes the selected ids via the `GETRECORDIDS()` formula function. The
flow's input variables map to this component's `@api objectApiName` /
`@api recordIds` (both declared `role="inputOnly"` in the meta XML).

Setup steps:

1. **Create the List Button** (Setup → Object Manager → Lead (or
   Opportunity) → Buttons, Links, and Actions → New Button or Link):
   - Display Type: **List Button**
   - Behavior: **Display in existing window without sidebar or header**
     (or a new window)
   - Content Source: **URL**
   - Formula:
     `/flow/Power_Dial_Flow?varRecordIds={!GETRECORDIDS($ObjectType.Lead.Id)}&varObjectApiName=Lead`
     (adjust the object and flow API name; a separate button+formula is
     needed per object since `GETRECORDIDS` is object-typed).
   - Add the button to the object's **Search Layout** so it shows up with
     the row checkboxes on the list view.
2. **Build the Screen Flow** (`Power_Dial_Flow`, Flow Builder, type
   *Screen Flow*):
   - Add two **Text** / **Text Collection** input variables,
     `varRecordIds` (Text Collection, Available for Input) and
     `varObjectApiName` (Text, Available for Input), matching the URL
     query params above.
   - Add a Screen element containing this component (search "Power Dial" in
     the Flow Builder component palette after deploying). Wire the screen
     component's `objectApiName` / `recordIds` inputs to the flow variables.
   - Activate the flow.
3. Confirm: select two or three Leads on the list view, click the button —
   the flow screen should open showing "Power Dial (N)" with N matching your
   selection.

This is the path to wire up first in-org; it's the only one of the four
targets that actually receives a live multi-record list-view selection.
**Do this for both Lead and Opportunity** — a separate List Button + Flow
per object, since `GETRECORDIDS()` is object-typed and each object needs
its own list-view button.

### `lightning__AppPage` / `lightning__HomePage` — manual testing only

Drop the component on a Lightning App Page or Home Page via Lightning App
Builder for manual QA. The `objectApiName` / `recordIds` design-time
attributes let an admin pin a fixed test payload (e.g. `Lead` +
`00Q...,00Q...`) — this is a static, admin-configured value, **not** a live
list-view selection. Useful for testing the Apex relay call and the
button/label rendering in isolation without building the Flow above.

## 5. The handoff contract (request shape)

`sendToCtiRelay()` calls the Apex method, which POSTs:

```json
{ "salesforceUserId": "005...", "objectType": "Lead", "recordIds": ["00Q...", "00Q..."] }
```

to `callout:CTI_PowerDial/dialer/handoffs` with header
`x-handoff-secret: <the shared secret>` and `Content-Type: application/json`.
This is the **exact** contract `services/cti-api/src/routes/dialer.ts`'s
`POST /dialer/handoffs` expects (see `parseHandoffInput` in
`services/cti-api/src/dialer/handoff-store.ts`): `objectType` must be
`'Lead'` or `'Opportunity'`, `recordIds` a non-empty array (≤500) of
15/18-char alphanumeric Salesforce ids, `salesforceUserId` likewise a valid
Salesforce id. `salesforceUserId` is always `UserInfo.getUserId()` — the
Apex caller's own id, set server-side, never a client-supplied value from
the LWC.

The endpoint upserts a `pending` row keyed by `salesforceUserId`
(superseding any earlier still-pending handoff for that rep). The rep's CTI
softphone (`apps/cti-web/src/App.tsx`) polls
`GET /dialer/handoffs/pending` roughly every 5 seconds while signed in and
idle; that route resolves the *authenticated rep's own* Salesforce user id
server-side from `salesforce_connections` (never trusts a client-supplied
id — no IDOR) and atomically claims (one-shot) the latest pending handoff,
then calls the existing `startPowerDial(objectType, recordIds)` to start
the run.

## 6. Handoff mechanism — why a server relay, not `postMessage`

An earlier version of `powerDial.js` attempted a direct
`window.postMessage` from this LWC to the CTI softphone's utility-bar
iframe. That does not work reliably: Lightning Web Components under
Lightning Web Security run in their own sandboxed iframe, nested below the
Salesforce Aura shell, with no supported API to reach across utility-bar
iframe boundaries to another arbitrary iframe. `PowerDialRelay.cls` +
`GET /dialer/handoffs/pending` replace that with a server-mediated handoff:
Apex makes an authenticated HTTP callout (Named Credential-backed, §3) to
an endpoint the CTI API already trusts, and the already-running,
already-authenticated CTI softphone picks the request up on its own next
poll — no iframe needs to reach another iframe.

The LWC also still fires an SLDS toast (`ShowToastEvent`) on
success/failure so the rep gets immediate feedback in Salesforce, ahead of
the ~5s the softphone's poll may take to pick the handoff up.

## 7. Testing the CTI side without Salesforce

You don't need an org to exercise the CTI-side half of the contract. Once
`HANDOFF_SHARED_SECRET` is set (§3, step 4), you can POST directly:

```bash
curl -X POST https://ctiapi-production.up.railway.app/dialer/handoffs \
  -H "Content-Type: application/json" \
  -H "x-handoff-secret: <the shared secret>" \
  -d '{"salesforceUserId":"005000000000001AAA","objectType":"Lead","recordIds":["00Q000000000001AAA"]}'
```

then, with a rep signed into `apps/cti-web` whose `salesforce_connections`
row has that same `sfUserId`, confirm the softphone auto-starts the run
within ~5 seconds (its poll interval). This exercises the entire relay
end-to-end without needing a working Salesforce org or List Button/Flow
wiring yet.
