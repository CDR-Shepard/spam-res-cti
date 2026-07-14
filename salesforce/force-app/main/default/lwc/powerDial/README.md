# Power Dial LWC — Setup Guide

**Status: metadata scaffold only. Not deployed, not wired in any org.**
Deploying this, wiring it into Setup, and building the recommended
server-relay integration (below) are all separate, user-gated steps.

This folder is the Salesforce (Lightning Web Component) half of the Power
Dialer handoff: it collects a set of Lead/Opportunity record ids and hands
them to the CTI power dialer running in `apps/cti-web` (the Open CTI
softphone, served by `services/cti-api` at `/cti/` and loaded as a Lightning
utility item — see the repo root `README.md`, "Salesforce phone tab").

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

Once `sfdx-project.json` exists:

```bash
cd salesforce   # the directory containing sfdx-project.json
sf org login web -a myorg          # if not already authenticated
sf project deploy start -d force-app/main/default/lwc/powerDial -o myorg
```

## 2. Files in this bundle

| File | Purpose |
|---|---|
| `powerDial.js` | Resolves the object type + record id(s) and posts a best-effort `POWER_DIAL` message. |
| `powerDial.html` | A "Power Dial (N)" button + a status line. |
| `powerDial.js-meta.xml` | `apiVersion` 60.0, `isExposed`, and four targets (below). |
| `README.md` | This file. |

## 3. Targets — what each one is actually good for

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

This is the path worth validating in-org first; it's the only one of the
four targets that actually receives a live multi-record list-view
selection.

### `lightning__AppPage` / `lightning__HomePage` — manual testing only

Drop the component on a Lightning App Page or Home Page via Lightning App
Builder for manual QA. The `objectApiName` / `recordIds` design-time
attributes let an admin pin a fixed test payload (e.g. `Lead` +
`00Q...,00Q...`) — this is a static, admin-configured value, **not** a live
list-view selection. Useful for testing `sendToCti()` and the button/label
rendering in isolation without building the Flow above.

## 4. The handoff contract (message shape)

`sendToCti()` builds and attempts to send:

```json
{ "type": "POWER_DIAL", "objectType": "Lead", "recordIds": ["00Q...", "00Q..."] }
```

The CTI app listens for exactly this shape in
`apps/cti-web/src/App.tsx` (`startPowerDial`, wired from a
`window.addEventListener('message', ...)` handler around line 549). It
validates `objectType` is `'Lead'` or `'Opportunity'` and `recordIds` is a
non-empty array of non-blank strings, then calls
`POST /dialer/sessions` (`startDialer`) and joins the rep's softphone to the
power-dialer conference.

**Important accuracy note on the listener's origin check:** the CTI's
handler only accepts messages where `event.source === window.parent`
(App.tsx, same block — see the comment "Minimal origin sanity"). In
Lightning Experience, the CTI iframe's `window.parent` is a Salesforce
Aura/LWS container frame, not this LWC's own window — see below for why
that matters.

## 5. Handoff mechanism — the honest limitation, and the recommended fix

**The `window.postMessage(payload, '*')` call in `powerDial.js` is a
best-effort attempt, not a working integration.** Do not treat it as
functional until it's been verified in a real org. Concretely:

- Lightning Web Components in Lightning Experience (with Lightning Web
  Security / Locker) run inside their own sandboxed iframe, nested several
  levels below the Salesforce Aura shell. This LWC has no reachable
  reference to the CTI utility-bar iframe's `window` or `contentWindow` —
  there is no supported LWC API to reach across utility-bar iframe
  boundaries to another arbitrary iframe.
- The call in this component is literally `window.postMessage(payload, '*')`
  — posting to the LWC's **own** window, which only self-notifies listeners
  in that same sandboxed frame. It does not climb the frame tree at all, so
  as implemented it will not reach the CTI iframe even in the best case.
  Even changing it to `window.parent.postMessage(...)` would only reach the
  LWC's immediate parent frame in Salesforce's iframe nesting — almost
  certainly not the CTI iframe's own immediate parent, so it would still
  fail the CTI's `event.source === window.parent` check quoted above.
- This is why the code is written the way it is: it demonstrates the exact
  documented message shape (useful for the manual test in §6, and as
  living documentation of the contract) without pretending a direct
  cross-iframe path exists.

### Recommended path to validate in-org: a small server relay

Instead of iframe-to-iframe `postMessage`, have the Salesforce side record
the selected ids **server-side**, and have the already-running,
already-authenticated CTI softphone (`apps/cti-web`, polling
`services/cti-api` continuously for its own dialer/call state) pick the
request up on its own next poll. Concretely, this would need:

1. **A new `services/cti-api` endpoint**, e.g.
   `POST /power-dial/pending` — accepts `{ salesforceUserId, objectType,
   recordIds }`, resolves `salesforceUserId` to a rep (the existing
   `services/cti-api/src/salesforce/current-user.ts` already resolves a
   rep's own Salesforce User Id the other direction — via `sfFetch` off an
   authenticated rep session — so the mapping primitive exists, but nothing
   today maps *from* a Salesforce User Id back *to* a rep on an unauthenticated
   inbound request; that lookup + its auth story is new work), and stores
   the pending request (in-memory/DB, keyed by rep).
2. **An Apex class** on the Salesforce side, invoked from this LWC (in
   place of, or alongside, `sendToCti()`), that makes an authenticated HTTP
   callout to that endpoint — via a **Named Credential** pointing at the
   `cti-api` host, so the org, not this repo, holds the credential.
3. **A poll (or push) added to `apps/cti-web`** — alongside its existing
   dialer-session polling — that periodically checks
   `GET /power-dial/pending` and, when one appears, calls the same
   `startDialer()` path `startPowerDial` already calls today, then
   acknowledges/clears the pending request.

This avoids the cross-iframe problem entirely (no iframe needs to reach
another iframe — everything routes through the API both sides already
trust), at the cost of new backend + Apex work. **None of that is built by
this task.** Building the relay endpoint, the Apex/Named Credential, and the
`cti-web` poll is the concrete follow-up to authorize and scope separately
— this README documents the shape of that choice so it can be decided on
its own, not bundled into a metadata-scaffold commit.

## 6. Testing the CTI side without Salesforce

You don't need an org to exercise the CTI-side half of the contract. With
`apps/cti-web` running standalone (`npm run dev:web`, or the deployed
`/cti/` page loaded directly, not inside a Salesforce iframe — so its
`window.parent === window` and the origin check in §4 passes), open the
browser console on that page and run:

```js
window.postMessage({ type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] }, '*');
```

This exercises `startPowerDial` exactly as the LWC's `sendToCti()` intends
to (same message shape), independent of whether the Salesforce-side
transport in §5 is ever wired up.
