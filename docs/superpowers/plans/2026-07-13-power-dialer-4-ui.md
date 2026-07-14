# Power Dialer — Plan 4: CTI Panel + Salesforce LWC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** The rep-facing UI — a CTI dialer panel (progress + controls + join the conference + screen-pop the connected record) — plus the Salesforce list-view "Power Dial" button that hands selected records to it.

**Architecture:** `apps/cti-web` gets a `dialer-api.ts` client, a `DialerPanel` component, and App wiring (a "Power Dial" tab, the conference join via `device.connect({params:{DialerConference:'1'}})`, and Open CTI `navigateToSObject` screen-pop driven by polling the session's current connected record). The Salesforce side is an LWC list-view quick action that collects selected record ids and posts them to the CTI panel. The React side is browser-verifiable; the LWC is deployed + wired in Salesforce Setup (a user-gated step).

**Tech Stack:** React + TypeScript + Vite (`apps/cti-web`), Twilio Voice SDK (already integrated), Salesforce Open CTI + LWC.

## Global Constraints

- TS strict; `apps/cti-web` builds clean (`npm run build` from `apps/cti-web`) and `npx tsc --noEmit` passes.
- Reuse the existing `apps/cti-web/src/api.ts` (`api()` helper + session token) and the existing persistent Twilio `device` in `App.tsx` — do NOT create a second device.
- Screen-pop is CLIENT-driven: the panel polls `GET /dialer/sessions/:id`; when `currentItem` becomes a NEW connected record, call Open CTI `navigateToSObject(recordId)`.
- The dialer panel is admin-and-rep visible (any signed-in rep). Follow the existing tab/panel patterns in `App.tsx`.
- Commit per task on `feat/power-dialer-foundations`; do NOT push. The Salesforce metadata is committed to the repo but deploying it to the org is out of scope for this plan (a separate, user-gated `sf project deploy`).

**Setup:** on `feat/power-dialer-foundations`.

---

### Task 1: Dialer API client

**Files:**
- Create: `apps/cti-web/src/dialer-api.ts`
- Test: `apps/cti-web/src/dialer-api.test.ts`

**Interfaces:**
- Consumes: `api` from `./api.js` (`api<T>(path, { method?, body? })`).
- Produces:
  - `type DialerSessionView = { session: { id: string; status: 'active'|'paused'|'stopped'|'done' }; counts: { total; done; connected; noConnect; skipped; unreachable; pending }; currentItem: { id: string; recordId: string; objectType: string; status: string; toNumber: string | null } | null }`
  - `startDialer(objectType: 'Lead'|'Opportunity', recordIds: string[]): Promise<{ sessionId: string; total: number }>`
  - `getDialer(id: string): Promise<DialerSessionView>`
  - `dialerControl(id: string, action: 'pause'|'resume'|'skip'|'stop'|'next'): Promise<{ ok: boolean }>`

- [ ] **Step 1: failing test** — a pure builder for the control path so we can test URL construction without a live server:

```ts
// apps/cti-web/src/dialer-api.test.ts
import { describe, expect, it } from 'vitest';
import { dialerControlPath, startBody } from './dialer-api.js';
describe('dialer-api path/body builders', () => {
  it('builds control paths and a start body', () => {
    expect(dialerControlPath('abc', 'pause')).toBe('/dialer/sessions/abc/pause');
    expect(dialerControlPath('abc', 'next')).toBe('/dialer/sessions/abc/next');
    expect(startBody('Lead', ['00Q1', '00Q2'])).toEqual({ objectType: 'Lead', recordIds: ['00Q1', '00Q2'] });
  });
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3: implement** — `dialerControlPath(id, action) = `/dialer/sessions/${id}/${action}``; `startBody(objectType, recordIds) = { objectType, recordIds }`; the three async fns call `api()` with those. (If `apps/cti-web` has no vitest yet, add `"test": "vitest run"` to its package.json and `vitest` devDep if missing — check first; the repo already uses vitest in `services/cti-api`.)
- [ ] **Step 4: verify** — `cd apps/cti-web && npx vitest run src/dialer-api.test.ts && npx tsc --noEmit`.
- [ ] **Step 5: commit** — `git commit -am "feat(cti-web): dialer API client"`.

---

### Task 2: Open CTI navigateToSObject

**Files:**
- Modify: `apps/cti-web/src/opencti.ts` (add `navigateToSObject`)
- Test: none (thin Open CTI wrapper; mirror the existing `setPanelVisibility`/`saveCallLog` wrappers).

- [ ] **Step 1:** Read `apps/cti-web/src/opencti.ts`. Add, mirroring the existing optional-chained wrappers:

```ts
/** Navigate the Salesforce console to a record (screen-pop). No-op outside SF. */
export function navigateToSObject(recordId: string): void {
  try {
    (window as unknown as { sforce?: { opencti?: { screenPop?: (o: unknown) => void } } })
      .sforce?.opencti?.screenPop?.({ type: 'sobject', params: { recordId } });
  } catch { /* not embedded in SF */ }
}
```
(If the file already imports an `sforce.opencti` handle differently, follow that pattern instead — the point is a safe, no-op-outside-SF `screenPop`/`navigateToSObject` by record id.)

- [ ] **Step 2: verify** — `npx tsc --noEmit`.
- [ ] **Step 3: commit** — `git commit -am "feat(cti-web): Open CTI navigateToSObject screen-pop"`.

---

### Task 3: DialerPanel component

**Files:**
- Create: `apps/cti-web/src/components/DialerPanel.tsx`
- Modify: `apps/cti-web/src/styles.css` (panel styles, matching existing conventions)
- Test: `apps/cti-web/src/components/DialerPanel.test.tsx` (render + a control click via @testing-library if present; else a pure helper test for the progress label)

**Interfaces:**
- Consumes: `DialerSessionView`, `getDialer`, `dialerControl` (Task 1); `navigateToSObject` (Task 2).
- Produces: `progressLabel(counts): string` (pure, e.g. `"3 of 20 · 1 connected · 2 skipped"`), and `function DialerPanel(props: { sessionId: string | null; onScreenPop: (recordId: string) => void; onStart: () => void; onStop: () => void }): JSX.Element`.

**Behavior:** when `sessionId` is set, poll `getDialer(sessionId)` every ~2s; render `progressLabel(counts)`, the current record (recordId/toNumber/status), and controls — **Pause/Resume** (toggle on status), **Skip**, **Stop**, and **Next** (enabled only when `currentItem.status === 'connected'`). When a NEW `currentItem` with `status === 'connected'` appears (id changed from the last polled), call `props.onScreenPop(currentItem.recordId)`. When status is `done`/`stopped`, stop polling and show a summary. When no `sessionId`, show a "No active run — start one from a Salesforce list view" empty state.

- [ ] **Step 1: failing test** — `progressLabel`:

```ts
// (inside DialerPanel.test.tsx or a colocated pure test)
import { progressLabel } from './DialerPanel.js';
it('progressLabel summarizes counts', () => {
  expect(progressLabel({ total: 20, done: 3, connected: 1, noConnect: 5, skipped: 2, unreachable: 0, pending: 9 }))
    .toBe('3 of 20 done · 1 connected · 2 skipped');
});
```

- [ ] **Step 2–5:** implement `progressLabel` (pure, exported) + the component (poll with `useEffect`+`setInterval`, clear on unmount/terminal; screen-pop on connected-id change; controls call `dialerControl`). Verify `npx vitest run` + `npx tsc --noEmit` + `npm run build`. Commit `feat(cti-web): DialerPanel (progress + controls + screen-pop)`.

---

### Task 4: Wire the panel into App (tab + conference join + record intake)

**Files:**
- Modify: `apps/cti-web/src/App.tsx`

**Behavior:**
- Add a **"Power Dial"** tab to the nav (`Tab` union + `navItems`), rendering `<DialerPanel …/>` in the body when selected.
- Hold `dialerSessionId` state. Provide `onScreenPop = (recordId) => navigateToSObject(recordId)`.
- **Conference join:** when a run starts (sessionId set), the rep's softphone joins its dialer conference: `device.connect({ params: { DialerConference: '1' } })` using the existing persistent `device` (reuse `ensureDevice()`), stored as a separate connection ref so it doesn't collide with a normal call. On Stop/done, disconnect that connection.
- **Record intake (handoff seam):** add a `window.addEventListener('message', …)` listener that accepts `{ type: 'POWER_DIAL', objectType, recordIds }` messages (from the Salesforce LWC / a test harness), calls `startDialer(objectType, recordIds)`, sets `dialerSessionId`, switches to the Power Dial tab, and joins the conference. (Validate `objectType ∈ {Lead,Opportunity}` and `recordIds` is a non-empty string array before calling.)

- [ ] **Step 1–4:** implement per the behavior; guard the message origin minimally (accept only same-embedding parent; ignore malformed payloads). Verify `npx tsc --noEmit` + `npm run build` (from `apps/cti-web`). Commit `feat(cti-web): Power Dial tab + conference join + list-view record intake`.

- [ ] **Step 5 (browser verify):** start the dev server, load the app, confirm: the Power Dial tab renders the empty state; a simulated `postMessage({type:'POWER_DIAL',objectType:'Lead',recordIds:['00Q…']})` switches to the tab and calls `startDialer` (network tab shows `POST /dialer/sessions`). Capture a screenshot.

---

### Task 5: Salesforce "Power Dial" list-view LWC (metadata — deploy user-gated)

**Files:**
- Create under a new `salesforce/force-app/main/default/lwc/powerDial/` : `powerDial.js`, `powerDial.html`, `powerDial.js-meta.xml` (targets: `lightning__RecordAction`? no — a **list view** action; use `lightning__UrlAddressable` or a **List View Button** invoking an Aura/LWC quick action). Also a `README.md` documenting the Setup wiring.
- Test: none in CI (LWC Jest is out of scope; the JS is small).

**Behavior:** the component reads the selected record ids from the list view context, resolves the object API name (`Lead`/`Opportunity`), and `window.postMessage({ type: 'POWER_DIAL', objectType, recordIds }, '*')` to the CTI utility-bar iframe (or uses `lightning/messageService` if the CTI panel subscribes). Include a `README.md` with exact Setup steps: deploy via `sf project deploy start`, add the LWC as a List View button on Lead & Opportunity, ensure the CTI panel (utility bar) is in the same Lightning app (Sales Console).

- [ ] **Step 1:** Write `powerDial.js` (a minimal LWC exposing an `@api recordIds`/list-selection handler + the postMessage), `powerDial.html` (a button), `powerDial.js-meta.xml` (isExposed true, appropriate targets), and the `README.md` Setup guide.
- [ ] **Step 2:** No CI test. Verify the files are well-formed (valid XML, valid JS). Commit `feat(sf): Power Dial list-view LWC (deploy + wire in Setup — see README)`.

---

### Task 6: Full green + web build

- [ ] `cd services/cti-api && npx tsc --noEmit && npx vitest run` (backend still green) AND `cd apps/cti-web && npx tsc --noEmit && npx vitest run && npm run build`. `git status -sb` clean, unpushed.

---

## Self-Review

**Spec coverage:** list-view button → CTI (§3) → Tasks 4-5. progress + controls (§3) → Task 3. screen-pop on connect (§3) → Tasks 2-4. conference join (§3) → Task 4.

**User-gated (cannot complete autonomously):** deploying the LWC to the org + wiring it as a Lead/Opportunity list-view button in Salesforce Setup (Task 5 README); placing live screening calls to validate the full loop (AMD → bridge → screen-pop → disposition → next).

**Deferred (from Plan 3 carry-forward, tracked in the SDD ledger):** the dialer-recording compliance decision + persistence; a stale-'dialing' reaper; out-of-hours re-queue policy.
