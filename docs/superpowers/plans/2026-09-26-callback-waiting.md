# Callback Waiting During a Power-Dial Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A callback to a rep's own numbers during a power-dial run now reaches them. While they talk to a prospect it is rejected at once with a toast. Otherwise a banner offers **Pause & answer** or **Ignore**: Pause & answer parks the run, takes the call through the normal inbound path, and **Resume** re-joins the room before dialing starts again.

**Architecture:** On the API, one engine function, `takeCallback`, runs one transaction under the run's advisory lock. It pauses the run first, then cancels and requeues a dial that is still ringing, and hangs that dial up only after the commit. An owner-only route exposes it. The claim and connect paths become compare-and-swaps so they respect the pause, and the `/voice` conference join refuses a named run that doesn't own the rep's room. On the web, the Device accepts calls while busy. `callback-waiting.ts` decides where each incoming call goes, using a run snapshot that DialerPanel hands up to App. App runs Pause & answer in a fixed order (server first, then clear the ref, disconnect, and accept), keeps the parked run alive with a heartbeat, and on Resume re-joins and waits for Twilio to answer the leg before it POSTs `resume`.

**Tech Stack:** TypeScript; Fastify + Drizzle (Postgres); Twilio TwiML (`twilio` node lib); React 18 + Vite; Twilio Voice JS SDK 2.18.3; vitest (+ @testing-library/react, jsdom).

## Global Constraints

- Spec (binding): `docs/superpowers/specs/2026-09-26-callback-waiting-design.md`.
- House ordering rules:
  - "settle the row BEFORE hanging up";
  - "pause the session FIRST, before touching the item or hanging up";
  - "never join the rep-scoped conference before start is accepted", which extends to: for a paused run, join the leg first, then POST resume;
  - "clear dialerConnRef BEFORE disconnect()".
- Never let the SDK's beforeAccept disconnect the dialer leg.
- Every rendered SQL or TwiML change has a pinned test.
- The partial-index gotcha: use bare onConflictDoNothing() only on full unique indexes.
- No console.log. No `any` outside tests. Errors visible to the rep via the existing toast.
- A rep with no run in progress sees exactly today's incoming behaviour.
- Commits end with "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".
- Tests: the API uses vitest in services/cti-api (`npx vitest run <file>`); the web uses vitest in apps/cti-web.
- Every command in this plan runs from the worktree root; `cd <dir> && …` is relative to it.
- Where rep-visible errors surface:
  - Callback outcomes and failures go to App's toast.
  - A refused or failed Resume re-join goes to the Power Dial panel's existing error line, where every dialer-control failure already shows.
  - A chime the browser refuses is only `console.warn`ed: the banner is the signal, and there's nothing for the rep to do.
- Device: `allowIncomingWhileBusy: true` in the `new Device(...)` options at construction. Never `updateOptions` (it rebuilds the sound cache and loses the ringtone speaker chosen in Settings).
- "Talking" is one rule on both sides: current item `status === 'connected'` and `prospectEndedAt` not set (spec decision 3). Server: `isTalking` in `dialer/state.ts`. Web: `isTalking` in `callback-waiting.ts`.
- 409 contract: `POST /dialer/sessions/:id/take-callback` answers `409 { error: string, reason: 'connected' }` exactly when a prospect is on the line, and has changed nothing. The web treats status 409 **with** `reason === 'connected'` as "talking". Any other failure is a plain error.
- Rep-facing strings (exact):
  - Banner: `Callback: <caller name or formatted number> · <record type>` (without a record type: `Callback: <caller>`). Buttons: `Pause & answer` (`Pausing…` while in flight), `Ignore`.
  - `Missed callback from <caller> — you were on a call. It went to <your cell|voicemail>.` (`your cell` when the rep has a no-answer forward in Settings.)
  - `Missed callback from <caller> — Power Dial couldn't pause your run. It went to <your cell|voicemail>.`
  - `The caller hung up before you answered.`
  - `Couldn't pause the run to answer: <reason>`
  - `Power Dial lost its audio connection, so the run is paused. Press Resume to continue.`
  - `Couldn't rejoin the run — if another power-dial run of yours is live, stop it first.`
  - `Finish the current call before resuming the run.`
  - `Can't reach the server — your paused Power Dial run may be stopped if this goes on. Check your connection.`
- The 25 s ring window is server-side (shipped in 9e53456) and unchanged. iOS (`apps/cti-ios`) and `apps/cti-desktop` are unchanged.
- Parked-run heartbeat: `GET /dialer/sessions/:id` every 60 s while parked (the reaper's window is 10 min).
- `App.tsx` (1672 lines) and `DialerPanel.tsx` (1092 lines) are already over the 800-line guideline. Put new logic in the new modules this plan creates and keep the App/DialerPanel edits to glue. Don't restructure either file.
- Work in `/Users/cdrshepard/spam-res-cti/.claude/worktrees/callsign-main` on `main`. In a harness worktree, run `git merge --ff-only main` FIRST, then `npm install --no-audit --no-fund --prefer-offline` and `for p in phone db auth firewall contracts; do (cd packages/$p && npm run build); done`.
- TDD (red first). Never `git stash`, never push, never deploy, never touch production.

## Design decisions this plan settles (one line of why each)

1. **Cancelling a ringing dial.** `takeCallback` settles it `status='skipped', outcome='canceled'` and inserts a pending copy with the same ordinal, number and attempt, `redialOf` carried, and a 5-minute `retryNotBefore`. Why: `skipped`+`canceled` is the one existing (status, outcome) pair nothing else writes. The rollover and the Chatter sweep already ignore both halves. The ceiling can leave exactly this pair out (Task 1 Steps 20–24), while Skip (`skipped`, no outcome) and Stop-while-ringing (`no_connect`/`canceled`) keep counting. The copy keeps the attempt, so the cancel isn't one of the person's tries. The 5-minute floor is the same courtesy the miss-path requeue uses.
2. **`firstPassTotal` counts distinct ordinals.** Why: the requeued copy is an attempt-1, non-redial row, so counting rows would grow the "N records" line by one per callback. Ordinals are unique at creation (`ordinal: i`), and the copy reuses its original's.
3. **409 contract**, as in Global Constraints. The web reacts by rejecting the callback (forward or voicemail) with the "you were on a call" toast, and leaves the leg untouched. Why: the transaction rolls back when the dial connects under it, so a 409 really did change nothing.
4. **Talking vs. not talking at arrival.** The web judges it from DialerPanel's latest poll, lifted to App. A snapshot of a different run, or none yet, counts as "not talking" (the banner shows). Why: the server's 409 is the authority, and a banner the rep can Ignore beats a lost callback.
5. **Stale snapshot (up to 2 s; 1 s while a dial rings).** If a dial connects after the banner went up, the next poll that shows "talking" rejects the waiting callback with the toast. If the rep clicks first, take-callback answers 409 and the web does the same. Why: the banner must not sit over a live conversation.
6. **Chime.** Two beeps of the Settings test tone (`playTestTone` in `audio-device-port.ts`, `setSinkId` to `loadAudioPrefs().output`), 450 ms apart, once per banner. Why: the SDK plays no ringtone for a call that arrives while another is up, and this reuses the WAV helper that already routes to the chosen speaker.
7. **Heartbeat.** It lives in App, as an effect keyed on the parked run id (`parked-heartbeat.ts`). It starts when the rep leaves the room for a callback. It stops when Resume re-joins, on Stop, when a beat reads the run as done or stopped (which also releases it), and on unmount. Why: the panel, which normally polls, is unmounted while the call screen shows.
8. **Leg drop while a callback rings (spec decision 9).** The dropped-leg handler skips recovery. It calls take-callback (pause, and cancel a ringing dial, since nobody is in the room to bridge it to), parks the run, and hands the callback to the ordinary ring screen. If the run can't be paused (409 or error), it rejects the callback with a toast and recovers as usual. Why: `connect()` silently `ignore()`s a pending call, and a live run must never keep dialing into an empty room.
9. **Races the spec's ordering needs closed** (additions, not spec changes):
   - The claim (`pending → dialing`) re-checks, under the same advisory lock, that the run is still `active`.
   - The connect becomes a compare-and-swap on `dialing`, and a connect that loses (or a `connected` outcome on a `skipped` row) is hung up rather than bridged.
   - Why: take-callback returns and the rep leaves the room. Without these, an advance already past its status check, or an AMD "human" read just before the cancel, bridges a person into the empty room and screen-pops them mid-callback.
10. **`/voice` guard.** A leg that names a run joins only if that run is live and no **other** run of the rep's is `active`. Otherwise it gets `<Reject/>`. A lookup failure lets the rep in. Why: the rep-scoped room belongs to the one active run. See "Spec decisions flagged" in the report for why this isn't the literal "newest non-terminal".
11. **One accept choke point.** `acceptCall` never answers while a dialer leg is live. It moves such a call to the banner instead. Why: a callback can reach the ring screen during the ~1 s join, and answering it there would let `beforeAccept` drop the new leg.

**Task shape note:** the run-snapshot lift is in Task 2, not Task 3, because Task 2's "talking → reject" branch can't be tested without it. Task 3 keeps everything else on the spec's Task 3 list.

---

## File structure

**API (Task 1)**
- Modify `services/cti-api/src/dialer/state.ts`: add `isTalking`.
- Modify `services/cti-api/src/dialer/engine.ts`: add `takeCallback`, `callbackRequeue` and `hangUpUnbridged`; guard the claim; make the connect a compare-and-swap.
- Modify `services/cti-api/src/routes/dialer.ts`: add `POST /dialer/sessions/:id/take-callback`; `firstPassTotal` counts ordinals.
- Create `services/cti-api/src/dialer/join-guard.ts` (+ `join-guard.test.ts`): the pure `mayJoinNamedRun`.
- Modify `services/cti-api/src/routes/telephony.ts`: add `dialerJoinAllowed`; the `/voice` conference branch answers `<Reject/>` when it refuses.
- Modify `packages/firewall/src/attempts.ts`: the ceiling leaves out callback cancels.
- Tests: `dialer/state.test.ts`, `dialer/engine.test.ts`, `routes/dialer.test.ts`, `routes/telephony-voice-conference.test.ts`, `packages/firewall/src/attempts.test.ts`.

**Web (Tasks 2–3)**
- Create `apps/cti-web/src/callback-waiting.ts` (+ test): the snapshot, the routing, the toasts, `runPauseAndAnswer`.
- Create `apps/cti-web/src/parked-heartbeat.ts` (+ test).
- Create `apps/cti-web/src/callback-chime.ts` (+ test): Task 3.
- Create `apps/cti-web/src/components/CallbackBanner.tsx` (+ test): Task 3.
- Modify `apps/cti-web/src/dialer-api.ts`: add `takeDialerCallback`.
- Modify `apps/cti-web/src/dialer-leg.ts`: add `legAccepted` (Task 3).
- Modify `apps/cti-web/src/components/DialerPanel.tsx`:
  - Task 2: `onRunSnapshot`.
  - Task 3: the banner, `withRejoin` / `ControlStep`, `PopLedger`.
- Modify `apps/cti-web/src/App.tsx`: the glue.
- Modify `apps/cti-web/src/styles.css`: banner styles (Task 3).
- Tests: `App.callback-waiting.test.tsx` (new), `components/DialerPanel.callback.test.tsx` (new), `App.test.tsx`, `dialer-api.test.ts`, `dialer-leg.test.ts`.

**Docs (Task 4)**
- `docs/runbooks/dialer-cadence.md`.
- The rep guide, which is outside this repo: `~/Documents/gg-guides-site/public/power-dial.html`.

---

### Task 1: API: take-callback, and the races around it

**Files:**
- Modify: `services/cti-api/src/dialer/state.ts` (append)
- Modify: `services/cti-api/src/dialer/engine.ts:1-12` (imports), `:365-384` (claim), `:716-760` (connect), append after `endCurrent` (`:714`)
- Modify: `services/cti-api/src/routes/dialer.ts:1-24` (header), `:38-49` (imports), `:336` (`firstPassTotal`), after `:419` (route)
- Create: `services/cti-api/src/dialer/join-guard.ts`, `services/cti-api/src/dialer/join-guard.test.ts`
- Modify: `services/cti-api/src/routes/telephony.ts:25` (import), after `:179` (helper), `:282-289` (the `/voice` conference branch)
- Modify: `packages/firewall/src/attempts.ts:69-80`
- Test: `services/cti-api/src/dialer/state.test.ts`, `services/cti-api/src/dialer/engine.test.ts`, `services/cti-api/src/routes/dialer.test.ts`, `services/cti-api/src/routes/telephony-voice-conference.test.ts`, `packages/firewall/src/attempts.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `services/cti-api/src/dialer/state.ts`: `export function isTalking(item: Pick<DialerItem, 'status' | 'prospectEndedAt'> | null): boolean`
  - `services/cti-api/src/dialer/engine.ts`:
    - `export type TakeCallbackResult = { action: 'paused'; canceledItemId: string | null } | { action: 'connected' } | { action: 'ready' | 'stopped' | 'done' | 'idle' }`
    - `export async function takeCallback(sessionId: string, deps: EngineDeps): Promise<TakeCallbackResult>`
  - HTTP `POST /dialer/sessions/:id/take-callback` (Bearer; owner-only; no power-dialer grant check, like every mid-run control). Responses:
    - 200 `{ ok: true, action: 'paused', canceledItemId: string | null }`
    - 200 `{ ok: true, action: 'ready' | 'stopped' | 'done' | 'idle' }`
    - 409 `{ error: string, reason: 'connected' }`
    - 401 `{ error: 'Unauthorized' }`
    - 404 `{ error: 'Not found' }`
  - HTTP `POST /telephony/twilio/voice` with `DialerConference=1&DialerSessionId=<uuid>`: answers `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>` (nothing stamped) when the named run isn't live or another of the rep's runs is `active`. Otherwise unchanged.
  - `services/cti-api/src/dialer/join-guard.ts`: `export function mayJoinNamedRun(sessionId: string, liveRuns: ReadonlyArray<{ id: string; status: string }>): boolean`
  - Data: a callback cancel is `dialer_queue_items.status = 'skipped' AND outcome = 'canceled'`.

#### 1a. `isTalking`

- [ ] **Step 1: Write the failing test.** In `services/cti-api/src/dialer/state.test.ts`, change the import on line 2 to:

```ts
import { earliestRetryAt, inFlightItem, isTalking, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
```

and append at the end of the file:

```ts
describe('isTalking — the rep is on the phone with a prospect (take-callback 409s on exactly this)', () => {
  it('a connected item whose prospect is still on the line', () => {
    expect(isTalking(row({ status: 'connected', prospectEndedAt: null }))).toBe(true);
  });
  it('not once the prospect hung up — Redial/Resume is waiting on the rep, who is free', () => {
    expect(isTalking(row({ status: 'connected', prospectEndedAt: new Date('2026-08-22T16:59:00Z') }))).toBe(false);
  });
  it('not while a dial only rings, and not between dials', () => {
    expect(isTalking(row({ status: 'dialing' }))).toBe(false);
    expect(isTalking(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/state.test.ts`
Expected: FAIL, with `isTalking is not a function`.

- [ ] **Step 3: Implement.** Append to `services/cti-api/src/dialer/state.ts`:

```ts
/** The rep is talking to a prospect: the in-flight item is connected and the
 *  prospect has not hung up. take-callback refuses (409) on exactly this, and
 *  the softphone applies the same rule to its own poll (apps/cti-web
 *  callback-waiting.ts `isTalking`). A connected item whose prospect already
 *  hung up is NOT talking — the rep is choosing Redial or Resume. */
export function isTalking(item: Pick<DialerItem, 'status' | 'prospectEndedAt'> | null): boolean {
  return item?.status === 'connected' && item.prospectEndedAt == null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/cti-api && npx vitest run src/dialer/state.test.ts`
Expected: PASS (all tests in the file).

#### 1b. `takeCallback`

- [ ] **Step 5: Extend the engine test fake so a transaction can read the session and pause it.** In `services/cti-api/src/dialer/engine.test.ts`, inside `fakeDb`'s `transaction()`, replace:

```ts
        query: {
          dialerQueueItems: { findMany: async () => items },
        },
```

with:

```ts
        query: {
          dialerQueueItems: { findMany: async () => items },
          // takeCallback reads the session under its advisory lock.
          dialerSessions: { findFirst: async () => ({ ...session, ...sessionOverride }) },
        },
```

and in the same `tx.update(...)`, replace:

```ts
                const apply = () => { writes.push({ patch }); txWrites.push({ patch, where: w }); Object.assign(_target, patch); };
```

with:

```ts
                const apply = () => {
                  writes.push({ patch }); txWrites.push({ patch, where: w }); Object.assign(_target, patch);
                  // takeCallback pauses the run inside its transaction.
                  if (_tbl === schema.dialerSessions) sessionOverride = { ...sessionOverride, ...patch };
                };
```

Then add `takeCallback,` to the `import { ... } from './engine.js';` list (after `endCurrent,`).

- [ ] **Step 6: Write the failing tests.** Append to `services/cti-api/src/dialer/engine.test.ts`:

```ts
describe('takeCallback — Pause & answer on a callback during a run', () => {
  beforeEach(() => { _target = {}; });
  const ringing = (o: Record<string, unknown> = {}) => ({
    id: 'i1', sessionId: 'S1', ordinal: 3, status: 'dialing', toNumber: '+16195550100',
    primaryNumber: '+16195550100', secondaryNumber: '+16195550111', recordId: '00Q1', objectType: 'Lead',
    callId: 'CA1', attempt: 1, redialOf: null, taskId: null, followupEligible: true,
    displayName: 'Jane Doe', listPosition: 7, prospectEndedAt: null, ...o,
  });
  const queued = { id: 'i2', sessionId: 'S1', ordinal: 4, status: 'pending', toNumber: '+16195550200', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1 };

  it('pauses FIRST, then settles the ringing dial skipped/canceled, and hangs it up LAST — after the transaction committed', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing(), queued]); deps.db = fdb;
    let committed = false;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => { const r = await realTx(fn); committed = true; return r; };
    const committedAtHangup: boolean[] = [];
    deps.telephony.hangup = vi.fn(async () => { committedAtHangup.push(committed); });
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: 'i1' });
    const pausedIdx = fdb._writes.findIndex((w: any) => w.patch.status === 'paused');
    const settledIdx = fdb._writes.findIndex((w: any) => w.patch.status === 'skipped');
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(settledIdx).toBeGreaterThan(pausedIdx);
    expect(fdb._writes[settledIdx].patch).toEqual(expect.objectContaining({ status: 'skipped', outcome: 'canceled' }));
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(committedAtHangup).toEqual([true]);
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  it('requeues the same person inside the same transaction: same number, same ordinal and attempt, not dialable for five minutes', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing(), queued]); deps.db = fdb;
    await takeCallback('S1', deps);
    expect(fdb._inserts).toEqual([]);
    expect(fdb._txInserts).toEqual([{ values: {
      sessionId: 'S1', ordinal: 3, objectType: 'Lead', recordId: '00Q1',
      toNumber: '+16195550100', fallbackNumber: null,
      primaryNumber: '+16195550100', secondaryNumber: '+16195550111',
      taskId: null, followupEligible: true, displayName: 'Jane Doe', listPosition: 7,
      attempt: 1, redialOf: null, status: 'pending',
      retryNotBefore: new Date(Date.UTC(2026, 6, 13, 18, 5, 0)),
    } }]);
  });

  it('a cancelled REDIAL copy stays one (redialOf carried), so it still gets no end-of-run retry of its own', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing({ redialOf: 'i0', attempt: 2 })]); deps.db = fdb;
    await takeCallback('S1', deps);
    expect(fdb._txInserts[0]!.values).toEqual(expect.objectContaining({ redialOf: 'i0', attempt: 2 }));
  });

  it('the settle is a compare-and-swap on `dialing`, and the pause cannot resurrect a stopped run (rendered SQL)', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing()]); deps.db = fdb;
    await takeCallback('S1', deps);
    const settle = fdb._txWrites.find((w: any) => w.patch.status === 'skipped')!;
    const s = new PgDialect().sqlToQuery(settle.where as SQL);
    expect(s.sql).toBe('("dialer_queue_items"."id" = $1 and "dialer_queue_items"."status" = $2)');
    expect(s.params).toEqual(['i1', 'dialing']);
    const pause = fdb._txWrites.find((w: any) => w.patch.status === 'paused')!;
    const p = new PgDialect().sqlToQuery(pause.where as SQL);
    expect(p.sql).toBe('("dialer_sessions"."id" = $1 and "dialer_sessions"."status" in ($2, $3))');
    expect(p.params).toEqual(['S1', 'active', 'paused']);
  });

  it("takes advanceSession's per-session lock before it reads anything, and reads through the transaction", async () => {
    const order: string[] = [];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing()]); deps.db = fdb;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => {
      const exec = tx.execute;
      tx.execute = async (q: any) => { order.push(`lock:${new PgDialect().sqlToQuery(q).params.join(',')}`); return exec(q); };
      const findSession = tx.query.dialerSessions.findFirst;
      tx.query.dialerSessions.findFirst = async (a: any) => { order.push('session'); return findSession(a); };
      const findItems = tx.query.dialerQueueItems.findMany;
      tx.query.dialerQueueItems.findMany = async (a: any) => { order.push('items'); return findItems(a); };
      return fn(tx);
    });
    await takeCallback('S1', deps);
    expect(order.slice(0, 3)).toEqual(['lock:S1', 'session', 'items']);
  });

  it('nothing ringing (between dials, or waiting on a retry): pauses and cancels nothing', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [queued]); deps.db = fdb;
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: null });
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'paused' }) }]);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('is idempotent: on a run already paused, with the dial already cancelled, it writes the same pause and nothing else', async () => {
    const deps = makeDeps();
    const fdb = fakeDb({ ...baseSession, status: 'paused' }, [ringing({ status: 'skipped', outcome: 'canceled' }), { ...queued, id: 'i1b', ordinal: 3 }]);
    deps.db = fdb;
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: null });
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'paused' }) }]);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('the 409 case — a prospect is on the line: answers `connected` and writes NOTHING, not even the pause', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing({ status: 'connected' })]); deps.db = fdb;
    expect(await takeCallback('S1', deps)).toEqual({ action: 'connected' });
    expect(fdb._writes).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('a prospect who already hung up is not "talking": pauses and leaves the connected item for Redial/Resume', async () => {
    const deps = makeDeps();
    const fdb = fakeDb(baseSession, [ringing({ status: 'connected', prospectEndedAt: new Date(Date.UTC(2026, 6, 13, 17, 59, 0)) })]);
    deps.db = fdb;
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: null });
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'paused' }) }]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('the dial connects UNDER us (the swap loses; the fresh read shows a live prospect): `connected`, and the transaction rolls back — the pause with it', async () => {
    const items = [ringing()];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    let rolledBack = false;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => {
      try {
        return await realTx(async (tx: any) => {
          const update = tx.update.bind(tx);
          // handleDialOutcome's connect commits between our read and our swap.
          tx.update = (tbl: any) => { if (tbl === schema.dialerQueueItems) items[0]!.status = 'connected'; return update(tbl); };
          return fn(tx);
        });
      } catch (err) { rolledBack = true; throw err; }
    };
    expect(await takeCallback('S1', deps)).toEqual({ action: 'connected' });
    expect(rolledBack).toBe(true);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('the dial settles itself as a miss under us: nothing left to cancel, the run stays paused', async () => {
    const items = [ringing()];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    let rolledBack = false;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => {
      try {
        return await realTx(async (tx: any) => {
          const update = tx.update.bind(tx);
          tx.update = (tbl: any) => { if (tbl === schema.dialerQueueItems) items[0]!.status = 'no_connect'; return update(tbl); };
          return fn(tx);
        });
      } catch (err) { rolledBack = true; throw err; }
    };
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: null });
    expect(rolledBack).toBe(false);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('leaves a run that is not live alone (stopped, done, ready): answers its status, writes nothing', async () => {
    for (const status of ['stopped', 'done', 'ready'] as const) {
      const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status }, [ringing()]); deps.db = fdb;
      expect(await takeCallback('S1', deps)).toEqual({ action: status });
      expect(fdb._writes).toEqual([]);
      expect(deps.telephony.hangup).not.toHaveBeenCalled();
    }
  });

  it('a dial whose originate has not returned yet (no call sid) is still settled and requeued — there is just nothing to hang up here', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing({ callId: null })]); deps.db = fdb;
    expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: 'i1' });
    expect(fdb._txInserts).toHaveLength(1);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('a failed hangup after the commit is logged, not thrown: the run is paused and the person requeued', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps(); const fdb = fakeDb(baseSession, [ringing()]); deps.db = fdb;
      deps.telephony.hangup = vi.fn(async () => { throw new Error('Call is not in-progress'); });
      expect(await takeCallback('S1', deps)).toEqual({ action: 'paused', canceledItemId: 'i1' });
      expect(fdb._txInserts).toHaveLength(1);
      expect(logged).toHaveBeenCalledWith('[dialer] take-callback hangup failed', expect.objectContaining({ sessionId: 'S1' }));
    } finally {
      logged.mockRestore();
    }
  });
});
```

- [ ] **Step 7: Run to verify they fail**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts -t takeCallback`
Expected: FAIL, with `takeCallback is not a function` in every test of the block.

- [ ] **Step 8: Implement.** In `services/cti-api/src/dialer/engine.ts`, change the two imports:

```ts
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
```

```ts
import { earliestRetryAt, inFlightItem, isTalking, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
```

Then insert directly after `endCurrent` (after its closing `}`, before `export async function handleDialOutcome`):

```ts
/** What `takeCallback` did. `connected` — a prospect is on the line — is the
 *  route's 409, and nothing was changed. */
export type TakeCallbackResult =
  | { action: 'paused'; canceledItemId: string | null }
  | { action: 'connected' }
  | { action: 'ready' | 'stopped' | 'done' | 'idle' };

/** Thrown inside takeCallback's transaction to roll it back (the pause too):
 *  the dial it was cancelling connected under it. */
class ProspectConnectedUnderUs extends Error {}

/**
 * The requeued copy of a dial cancelled to take a callback: the same person on
 * the same number, at the SAME ordinal (the run's first-pass total counts
 * ordinals — routes/dialer.ts — so it does not grow) and the same attempt (the
 * cancel is not one of the person's tries), not dialable for RETRY_FLOOR_MS so
 * nobody is rung twice inside five minutes. A cancelled redial copy stays one
 * (`redialOf`), so it still gets no end-of-run retry of its own.
 */
function callbackRequeue(item: DialerItem, now: Date): typeof schema.dialerQueueItems.$inferInsert {
  return {
    sessionId: item.sessionId,
    ordinal: item.ordinal,
    objectType: item.objectType,
    recordId: item.recordId,
    toNumber: item.toNumber,
    fallbackNumber: null,
    primaryNumber: item.primaryNumber,
    secondaryNumber: item.secondaryNumber,
    taskId: item.taskId,
    followupEligible: item.followupEligible,
    displayName: item.displayName,
    listPosition: item.listPosition,
    attempt: item.attempt,
    redialOf: item.redialOf,
    status: 'pending',
    retryNotBefore: new Date(now.getTime() + RETRY_FLOOR_MS),
  };
}

/**
 * Pause & answer: a callback rang while the rep was on this run and they chose
 * to take it (spec docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 * The softphone leaves the run's room right after this returns, so the run must
 * be left unable to put anyone in that room: paused, with no dial ringing.
 *
 * ONE transaction, holding the same per-session advisory lock as
 * advanceSession's claim: a claim already in progress has committed before we
 * read (its `dialing` row is visible below), and a claim that starts after we
 * pause re-checks the status in its compare-and-swap and backs off.
 *
 * ORDER — pause the session FIRST, before touching the item; settle the row
 * BEFORE hanging up; hang up LAST, after the commit:
 *  1. A prospect on the line (`isTalking`) → `connected`, nothing written.
 *  2. Pause — only a live run: the WHERE refuses to resurrect a Stop that
 *     landed since the read. A harmless re-write on an already-paused run.
 *  3. A ringing dial → `skipped` + `canceled`, compare-and-swapped on
 *     `dialing`, and its person requeued (`callbackRequeue`). That pair is
 *     written by nothing else: the rollover rule already ignores it
 *     (contact-history-live.ts `skipped`), the no-answer Chatter never posts on
 *     it, and the per-customer ceiling leaves exactly it out (@cti/firewall
 *     attempts.ts). The phone DID ring, so the state-law cap and the 3 h
 *     courtesy still count it. If the swap loses, the dial settled under us:
 *     connected → roll everything back (the pause too) and answer `connected`;
 *     a miss → nothing left to cancel, the run stays paused.
 *  4. After commit, hang the cancelled call up. Its `canceled` status callback
 *     then finds a settled row and `handleDialOutcome` no-ops. A dial whose
 *     originate had not returned yet has no sid to hang up here; if that
 *     person answers, `handleDialOutcome` hangs them up (the row is `skipped`).
 *
 * Idempotent: on a paused run with nothing ringing it writes the same pause
 * and answers `{ action: 'paused', canceledItemId: null }`.
 */
export async function takeCallback(sessionId: string, deps: EngineDeps): Promise<TakeCallbackResult> {
  let outcome: { result: TakeCallbackResult; hangUp: string | null };
  try {
    outcome = await deps.db.transaction(async (tx): Promise<{ result: TakeCallbackResult; hangUp: string | null }> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const session = await tx.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
      if (!session) return { result: { action: 'idle' }, hangUp: null };
      if (session.status !== 'active' && session.status !== 'paused') return { result: { action: session.status }, hangUp: null };
      const ofRun = eq(schema.dialerQueueItems.sessionId, sessionId);
      const item = inFlightItem(await tx.query.dialerQueueItems.findMany({ where: ofRun }));
      if (isTalking(item)) return { result: { action: 'connected' }, hangUp: null };
      await tx
        .update(schema.dialerSessions)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(schema.dialerSessions.id, sessionId), inArray(schema.dialerSessions.status, ['active', 'paused'])));
      if (!item || item.status !== 'dialing') return { result: { action: 'paused', canceledItemId: null }, hangUp: null };
      const settled = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'skipped', outcome: 'canceled', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, item.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ id: schema.dialerQueueItems.id });
      if (settled.length === 0) {
        if (isTalking(inFlightItem(await tx.query.dialerQueueItems.findMany({ where: ofRun })))) throw new ProspectConnectedUnderUs();
        return { result: { action: 'paused', canceledItemId: null }, hangUp: null };
      }
      await tx.insert(schema.dialerQueueItems).values(callbackRequeue(item, deps.nowUtc));
      return { result: { action: 'paused', canceledItemId: item.id }, hangUp: item.callId };
    });
  } catch (err) {
    if (err instanceof ProspectConnectedUnderUs) return { action: 'connected' };
    throw err;
  }
  if (outcome.hangUp) {
    try {
      await deps.telephony.hangup(outcome.hangUp);
    } catch (err) {
      console.error('[dialer] take-callback hangup failed', { sessionId, err: (err as Error).message });
    }
  }
  return outcome.result;
}
```

- [ ] **Step 9: Run to verify they pass**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts -t takeCallback`
Expected: PASS, 14 tests.

#### 1c. The claim never starts a dial on a paused run; a connect never bridges a settled row

- [ ] **Step 10: Write the failing tests.** Append to `services/cti-api/src/dialer/engine.test.ts`:

```ts
describe('advanceSession — a paused run never starts a dial', () => {
  beforeEach(() => { _target = {}; });
  it('the pending → dialing claim re-checks, inside the locked transaction, that the run is still active (rendered SQL)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await advanceSession('S1', deps);
    const claim = fdb._txWrites.find((w: any) => w.patch.status === 'dialing')!;
    const q = new PgDialect().sqlToQuery(claim.where as SQL);
    expect(q.sql).toBe(`("dialer_queue_items"."id" = $1 and "dialer_queue_items"."status" = $2 and exists (select 1 from dialer_sessions where id = $3 and status = 'active'))`);
    expect(q.params).toEqual(['i1', 'pending', 'S1']);
  });
});

describe('handleDialOutcome — a connect never bridges into a room the run gave up', () => {
  beforeEach(() => { _target = {}; });
  const dialing = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fromNumber: '+16190000000', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];

  it('the connect is a compare-and-swap on `dialing` (rendered SQL)', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    const swap = fdb._txWrites.find((w: any) => w.patch.status === 'connected')!;
    const q = new PgDialect().sqlToQuery(swap.where as SQL);
    expect(q.sql).toBe('("dialer_queue_items"."id" = $1 and "dialer_queue_items"."status" = $2)');
    expect(q.params).toEqual(['i1', 'dialing']);
  });

  it('a connect that loses the swap (take-callback or Skip settled the row) is hung up — never bridged, never popped, no sticky', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).not.toHaveBeenCalled();
    expect(deps.onScreenPop).not.toHaveBeenCalled();
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._inserts).toEqual([]);
  });

  it('a person answering a call whose row is already `skipped` (cancelled while its originate was in flight) is hung up', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'skipped', outcome: 'canceled', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(deps.telephony.bridgeToRep).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([]);
  });

  it('…but nothing is hung up for a duplicate "human" on a call that is already connected (the rep is talking)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', prospectEndedAt: null, toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });

  it('…nor for the late `canceled` status callback of the cancelled dial', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'skipped', outcome: 'canceled', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'canceled', deps);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
  });
});
```

- [ ] **Step 11: Run to verify they fail**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts -t "never starts a dial|never bridges"`
Expected: FAIL. The claim SQL has no `exists (...)`; the connect SQL has no `"status" = $2`; the losing connect bridges instead of hanging up; the skipped-row connect isn't hung up. The last two tests already pass.

- [ ] **Step 12: Implement.** In `engine.ts` `advanceSession`, replace the claim's `.where(...)`:

```ts
        .where(and(eq(schema.dialerQueueItems.id, next.id), eq(schema.dialerQueueItems.status, 'pending')))
        .returning({ id: schema.dialerQueueItems.id });
      return rows.length > 0;
```

with:

```ts
        .where(and(
          eq(schema.dialerQueueItems.id, next.id),
          eq(schema.dialerQueueItems.status, 'pending'),
          // Re-checked under the per-session lock: a run paused after this
          // advance read `active` (take-callback, Pause, a lost rep leg) must
          // not start a dial — the rep may already have left the room.
          sql`exists (select 1 from dialer_sessions where id = ${sessionId} and status = 'active')`,
        ))
        .returning({ id: schema.dialerQueueItems.id });
      return rows.length > 0;
```

In `handleDialOutcome`, replace:

```ts
  if (!item || item.status !== 'dialing') return;
```

with:

```ts
  if (!item) return;
  if (item.status !== 'dialing') {
    // A person answered a call whose row a rep action already settled — a Skip,
    // or take-callback while this dial's originate was still in flight, so
    // nothing held its sid to hang up. Nobody will bridge them: hang up rather
    // than leave them listening to the dialer-answer hold.
    if (outcome === 'connected' && item.status === 'skipped') await hangUpUnbridged(deps, callId, item.id);
    return;
  }
```

and replace the connected branch's transaction:

```ts
    await deps.db.transaction(async (tx) => {
      await tx.update(schema.dialerQueueItems).set({ status: 'connected', outcome: 'connected', updatedAt: new Date() }).where(eq(schema.dialerQueueItems.id, item.id));
      if (dialedNumber) await stampConnected(tx, item.id, dialedNumber, deps.nowUtc);
    });
```

with:

```ts
    //
    // A compare-and-swap on `dialing` — the read above is not a lock. A Skip or
    // take-callback that settled the row since then owns it, and bridging now
    // would put this person in a room the rep may already have left.
    const claimed = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'connected', outcome: 'connected', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, item.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ id: schema.dialerQueueItems.id });
      if (rows.length === 0) return false;
      if (dialedNumber) await stampConnected(tx, item.id, dialedNumber, deps.nowUtc);
      return true;
    });
    if (!claimed) { await hangUpUnbridged(deps, callId, item.id); return; }
```

Add this helper right above `export async function handleDialOutcome`:

```ts
/** Best-effort hang-up of an answered call nobody will be bridged to. Usually
 *  succeeds; "already gone" is the other common answer, so it only warns. */
async function hangUpUnbridged(deps: EngineDeps, callId: string, itemId: string): Promise<void> {
  try {
    await deps.telephony.hangup(callId);
  } catch (err) {
    console.warn('[dialer] unbridged call not hung up (usually already gone)', { itemId, err: (err as Error).message });
  }
}
```

- [ ] **Step 13: Run the whole engine suite**

Run: `cd services/cti-api && npx vitest run src/dialer/engine.test.ts src/dialer/state.test.ts`
Expected: PASS for every test in both files, including all pre-existing ones. The pre-existing connect tests still see one transaction with two `tx.update` calls, and the `status: 'connected'` write.

- [ ] **Step 14: Commit**

```bash
git add services/cti-api/src/dialer/state.ts services/cti-api/src/dialer/state.test.ts services/cti-api/src/dialer/engine.ts services/cti-api/src/dialer/engine.test.ts
git commit -F - <<'EOF'
feat(dialer): take-callback — pause first, cancel and requeue a ringing dial

One transaction under the claim's advisory lock: pause, settle a ringing
dial skipped/canceled (CAS on dialing) with a same-ordinal requeue copy,
hang up after commit; roll back to `connected` if the dial connected
under us. The claim now re-checks the run is active, and a connect is a
CAS on dialing that hangs up instead of bridging a settled row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

#### 1d. The route, and `firstPassTotal`

- [ ] **Step 15: Write the failing tests.** In `services/cti-api/src/routes/dialer.test.ts`, add two fields to the hoisted `state` (after `positionRows: [...]`, inside the object):

```ts
  takeCallbackResult: { action: 'paused', canceledItemId: null } as Record<string, unknown>,
  takeCallbackCalls: [] as string[],
```

Add after the `vi.mock('@cti/db', ...)` block:

```ts
// The route is what this file pins; takeCallback itself is pinned in
// dialer/engine.test.ts. Every other engine function stays real.
vi.mock('../dialer/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/engine.js')>()),
  takeCallback: async (sessionId: string) => {
    state.takeCallbackCalls.push(sessionId);
    return state.takeCallbackResult;
  },
}));
```

Add this test inside `describe('GET /dialer/sessions/:id — listContext', ...)`, right after the `firstPassTotal excludes a redial copy` test:

```ts
  it("firstPassTotal counts ordinals, not rows: a take-callback requeue copy shares its original's ordinal and never inflates it", async () => {
    state.session = { id: 'S6', orgId: 'O1', userId: 'U-ME', status: 'paused', listViewId: null };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: null, status: 'done' },
      // Cancelled to take a callback, and its requeued copy at the same ordinal.
      { attempt: 1, ordinal: 1, listPosition: null, status: 'skipped', outcome: 'canceled' },
      { attempt: 1, ordinal: 1, listPosition: null, status: 'pending' },
    ];
    const res = await get('S6');
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassTotal).toBe(2);
  });
```

Append at the end of the file:

```ts
describe('POST /dialer/sessions/:id/take-callback', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'active' };
    state.takeCallbackCalls = [];
    state.takeCallbackResult = { action: 'paused', canceledItemId: 'i1' };
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const post = (id: string) => app.inject({ method: 'POST', url: `/dialer/sessions/${id}/take-callback`, headers: { authorization: 'Bearer t' } });

  it('pauses the owned run through the engine and reports what it cancelled', async () => {
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'paused', canceledItemId: 'i1' });
    expect(state.takeCallbackCalls).toEqual(['S1']);
  });

  it('409 { reason: "connected" } when a prospect is on the line — the softphone keys on exactly this', async () => {
    state.takeCallbackResult = { action: 'connected' };
    const res = await post('S1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'You are talking to a prospect — finish that call first.', reason: 'connected' });
  });

  it('a run that already ended answers 200 with its status — there is nothing to pause', async () => {
    state.takeCallbackResult = { action: 'stopped' };
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'stopped' });
  });

  it("someone else's run 404s and never reaches the engine", async () => {
    state.session = null; // loadOwnedSession's scoped lookup finds nothing
    const res = await post('S-OTHER');
    expect(res.statusCode).toBe(404);
    expect(state.takeCallbackCalls).toEqual([]);
  });

  it('no session token → 401, never reaches the engine', async () => {
    state.authedUser = null;
    const res = await post('S1');
    expect(res.statusCode).toBe(401);
    expect(state.takeCallbackCalls).toEqual([]);
  });

  it('stays open to a rep whose power-dialer grant was revoked mid-run — a mid-run control, like pause', async () => {
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 16: Run to verify they fail**

Run: `cd services/cti-api && npx vitest run src/routes/dialer.test.ts`
Expected: FAIL. `firstPassTotal` is `3` (expected `2`), and the take-callback tests get 404 (no such route).

- [ ] **Step 17: Implement** in `services/cti-api/src/routes/dialer.ts`.

Add to the header comment list, after the `/end` line:

```ts
 *  POST /dialer/sessions/:id/take-callback → a callback rang mid-run: pause FIRST, cancel + requeue a ringing dial (409 if a prospect is on the line)
```

Add `takeCallback,` to the `import { ... } from '../dialer/engine.js';` list (after `endCurrent,`).

Replace:

```ts
      firstPassTotal: items.filter((i) => i.attempt === 1 && i.redialOf == null).length,
```

with:

```ts
      // Counted by ORDINAL: a take-callback requeue copy (engine.ts
      // `callbackRequeue`) is an attempt-1, non-redial row that reuses its
      // cancelled original's ordinal, and must not grow this either.
      firstPassTotal: new Set(items.filter((i) => i.attempt === 1 && i.redialOf == null).map((i) => i.ordinal)).size,
```

Insert after the `/end` route (after its closing `});`):

```ts
  // A callback rang while the rep is on this run and they chose Pause & answer
  // (spec 2026-09-26-callback-waiting-design.md). The softphone leaves the room
  // only after this succeeds. 409 — nothing changed — when a prospect is on the
  // line: the softphone then leaves the call alone and the callback forwards.
  // Ungated like every mid-run control (see requirePowerDialer).
  app.post('/dialer/sessions/:id/take-callback', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await takeCallback(owned.session.id, buildEngineDeps());
    if (result.action === 'connected') {
      return reply.code(409).send({ error: 'You are talking to a prospect — finish that call first.', reason: 'connected' });
    }
    return { ok: true, ...result };
  });
```

- [ ] **Step 18: Run to verify they pass**

Run: `cd services/cti-api && npx vitest run src/routes/dialer.test.ts`
Expected: PASS for every test in the file.

- [ ] **Step 19: Commit**

```bash
git add services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer.test.ts
git commit -F - <<'EOF'
feat(dialer): POST /dialer/sessions/:id/take-callback; firstPassTotal counts ordinals

Owner-only, ungated like the other mid-run controls; 409
{ reason: 'connected' } when a prospect is on the line. The run's
first-pass total counts ordinals so a callback requeue copy never
inflates the queue line.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

#### 1e. The per-customer ceiling leaves out a callback cancel

- [ ] **Step 20: Write the failing test.** In `packages/firewall/src/attempts.test.ts`, inside `it('scopes the dialer source to this org, this recipient, and the window', ...)`, replace:

```ts
    // Never dialer_queue_items: the fallback path rewrites that row's to/from.
    expect(wheres.some((w) => w.includes('dialer_queue_items'))).toBe(false);
```

with:

```ts
    // Counted FROM dialer_dial_attempts, never from dialer_queue_items (the old
    // fallback path rewrote that row's to/from). Items are read only to leave
    // out a dial cancelled to take a callback — see the next test.
    expect(wheres.filter((w) => w.includes('dialer_queue_items'))).toEqual([dialerWhere]);
```

and add this test right after it, inside `describe('customerAttemptCounts', ...)`:

```ts
  it('leaves out exactly a dial cancelled to take a callback (skipped + canceled) — every other dial still counts', async () => {
    // engine.ts takeCallback settles the ringing dial `skipped` + `canceled`, a
    // pair nothing else writes: a Skip is `skipped` with no outcome, a Stop
    // while ringing is `no_connect` + `canceled`. Both of those keep counting.
    const { db, wheres } = fakeDb({});
    await customerAttemptCounts(db, 'O1', '+16195559999', WINDOW_START);
    const dialerWhere = wheres.find((w) => w.includes('dialer_dial_attempts'))!;
    expect(dialerWhere).toContain(
      `not exists (select 1 from "dialer_queue_items" where "dialer_queue_items"."id" = "dialer_dial_attempts"."item_id" and "dialer_queue_items"."status" = 'skipped' and "dialer_queue_items"."outcome" = 'canceled')`,
    );
    const callsWhere = wheres.find((w) => w.includes('"calls"'))!;
    expect(callsWhere).not.toContain('not exists');
  });
```

- [ ] **Step 21: Run to verify it fails**

Run: `cd packages/firewall && npx vitest run src/attempts.test.ts`
Expected: FAIL, 2 tests. The filter finds `[]`, not `[dialerWhere]`, and `not exists` is absent.

- [ ] **Step 22: Implement.** In `packages/firewall/src/attempts.ts`, replace the dialer source's `.where(...)`:

```ts
        and(
          eq(schema.dialerDialAttempts.orgId, orgId),
          eq(schema.dialerDialAttempts.toNumber, toE164),
          gte(schema.dialerDialAttempts.dialedAt, windowStart),
        ),
```

with:

```ts
        and(
          eq(schema.dialerDialAttempts.orgId, orgId),
          eq(schema.dialerDialAttempts.toNumber, toE164),
          gte(schema.dialerDialAttempts.dialedAt, windowStart),
          // A dial the rep cancelled to take a callback (cti-api engine.ts
          // takeCallback: `skipped` + `canceled`, a pair nothing else writes) is
          // not an attempt for this ceiling — its person is requeued and dialed
          // again (spec 2026-09-26-callback-waiting-design.md). It still counts
          // for the state-law daily cap (daily-cap.ts) and the 3 h courtesy,
          // which read every attempt row: the phone did ring.
          sql`not exists (select 1 from ${schema.dialerQueueItems} where ${schema.dialerQueueItems.id} = ${schema.dialerDialAttempts.itemId} and ${schema.dialerQueueItems.status} = 'skipped' and ${schema.dialerQueueItems.outcome} = 'canceled')`,
        ),
```

and add one sentence to the function's doc comment, after the "NOT `dialer_queue_items`" paragraph:

```ts
 * (Items ARE read — by id, never for their to/from — to leave out a dial
 * cancelled to take a callback; see the `not exists` below.)
```

- [ ] **Step 23: Run to verify it passes, and rebuild the package the API imports**

Run: `cd packages/firewall && npx vitest run && npm run build`
Expected: PASS for every firewall test file, then `tsc` exits 0 with no output.

- [ ] **Step 24: Commit**

```bash
git add packages/firewall/src/attempts.ts packages/firewall/src/attempts.test.ts
git commit -F - <<'EOF'
feat(firewall): a callback cancel is not an attempt for the per-customer ceiling

Spec 2026-09-26: a dial cancelled to take a callback (skipped +
canceled) is requeued and does not count toward the ceiling. Skip and
Stop-while-ringing keep counting; the state-law cap and courtesy still
count every attempt row.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

#### 1f. The `/voice` guard: a named join must be the run that owns the room

- [ ] **Step 25: Write the failing pure test.** Create `services/cti-api/src/dialer/join-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mayJoinNamedRun } from './join-guard.js';

const A = '7b0e5c1a-2f4d-4c3b-9a8e-1d2c3b4a5f60';
const B = '0d6f2e1b-3c5a-4e7d-8f90-a1b2c3d4e5f6';

describe('mayJoinNamedRun', () => {
  it("the rep's only live run joins — active (Start) or paused (Resume after a callback re-joins first)", () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'active' }])).toBe(true);
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }])).toBe(true);
  });
  it("refuses a named run while ANOTHER run of the rep's is active: that run owns the rep-scoped room", () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }, { id: B, status: 'active' }])).toBe(false);
  });
  it('refuses a run that is no longer live (stopped or done: not in the list)', () => {
    expect(mayJoinNamedRun(A, [{ id: B, status: 'active' }])).toBe(false);
    expect(mayJoinNamedRun(A, [])).toBe(false);
  });
  it('a paused run left by a dead tab does not lock out the active run — nor one paused run another', () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'active' }, { id: B, status: 'paused' }])).toBe(true);
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }, { id: B, status: 'paused' }])).toBe(true);
  });
});
```

- [ ] **Step 26: Run to verify it fails**

Run: `cd services/cti-api && npx vitest run src/dialer/join-guard.test.ts`
Expected: FAIL, with `Failed to load url ./join-guard.js` (the module doesn't exist).

- [ ] **Step 27: Implement.** Create `services/cti-api/src/dialer/join-guard.ts`:

```ts
/**
 * May a softphone leg that NAMES a run (the `DialerSessionId` it joins with,
 * apps/cti-web dialer-leg.ts) enter the rep's power-dial room?
 *
 * The room is rep-scoped (`pd_<userId>`, twilio-telephony.ts `conferenceName`),
 * not per run, and the rep's one ACTIVE run owns it (the one-active-run
 * index). So the named run must still be live — active, or paused: Resume
 * after a callback re-joins a paused run BEFORE it resumes — and no OTHER run
 * of the rep's may be active. Otherwise a stale tab lands in the newer run's
 * room and, leaving it (every rep leg ends the room on exit), cuts that run's
 * call (spec 2026-09-26-callback-waiting-design.md decision 6).
 *
 * Deliberately not "the newest non-terminal run" by created_at: a newer run
 * that is only `ready` (a confirm block left open in another tab) or `paused`
 * (a dead tab's leftover) owns no room, and must not lock the rep out of the
 * run they are actually dialing.
 */
export function mayJoinNamedRun(sessionId: string, liveRuns: ReadonlyArray<{ id: string; status: string }>): boolean {
  if (!liveRuns.some((r) => r.id === sessionId)) return false;
  return !liveRuns.some((r) => r.id !== sessionId && r.status === 'active');
}
```

- [ ] **Step 28: Run to verify it passes**

Run: `cd services/cti-api && npx vitest run src/dialer/join-guard.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 29: Write the failing route tests.** In `services/cti-api/src/routes/telephony-voice-conference.test.ts`, add to the hoisted `state` (inside the object, after `validatedUrls: [] as string[],`):

```ts
  /** The rep's live runs, as the named-join guard reads them (user + status). */
  liveRuns: [] as Array<{ id: string; status: string }>,
  liveRunsThrows: false,
  liveRunsHang: false,
  liveRunLookups: [] as Array<{ where: unknown; columns?: unknown }>,
```

In the `@cti/db` mock, add a `findMany` to `dialerSessions` (after its `findFirst`):

```ts
          // The named-join guard's read of the rep's live runs.
          findMany: async (args: { where: unknown; columns?: unknown }) => {
            state.liveRunLookups.push(args);
            if (state.liveRunsThrows) throw new Error('pool exhausted');
            if (state.liveRunsHang) return new Promise(() => {});
            return state.liveRuns;
          },
```

In `beforeEach`, add (after `state.validatedUrls = [];`):

```ts
  state.liveRuns = [{ id: SESSION_ID, status: 'active' }];
  state.liveRunsThrows = false;
  state.liveRunsHang = false;
  state.liveRunLookups = [];
```

Append at the end of the file:

```ts
describe('POST /telephony/twilio/voice — a named join must be the run that owns the room', () => {
  const OTHER_ID = '0d6f2e1b-3c5a-4e7d-8f90-a1b2c3d4e5f6';
  const REJECT = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

  it('a paused run with no other active run joins — the Resume-after-callback case — and its leg is stamped', async () => {
    state.liveRuns = [{ id: SESSION_ID, status: 'paused' }];
    const res = await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(res.body).toContain('<Conference');
    expect(state.updates).toHaveLength(1);
  });

  it("a stale tab naming a paused run while ANOTHER run of the rep's is active gets <Reject/> — never answered, nothing stamped", async () => {
    state.liveRuns = [{ id: SESSION_ID, status: 'paused' }, { id: OTHER_ID, status: 'active' }];
    const res = await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(REJECT);
    expect(state.updates).toEqual([]);
    expect(state.hangups).toEqual([]);
  });

  it('a run that has ended (not among the live runs) is refused the same way', async () => {
    state.liveRuns = [{ id: OTHER_ID, status: 'active' }];
    expect((await join(REP_FROM, REP_CALL_SID, SESSION_ID)).body).toBe(REJECT);
  });

  it('the active run joins even when an older abandoned paused run exists', async () => {
    state.liveRuns = [{ id: SESSION_ID, status: 'active' }, { id: OTHER_ID, status: 'paused' }];
    expect((await join(REP_FROM, REP_CALL_SID, SESSION_ID)).body).toContain('<Conference');
  });

  it("reads the rep's own live runs only (their user id, active or paused)", async () => {
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(state.liveRunLookups).toHaveLength(1);
    expect(state.liveRunLookups[0]!.columns).toEqual({ id: true, status: true });
    const bound = paramValues(state.liveRunLookups[0]!.where).flat();
    expect(bound).toContain(REP_ID);
    expect(bound.filter((v) => ['active', 'paused', 'ready', 'done', 'stopped'].includes(v as string)).sort()).toEqual(['active', 'paused']);
  });

  it('no run named (an older softphone): no lookup, joins exactly as before', async () => {
    const res = await join();
    expect(res.body).toContain('<Conference');
    expect(state.liveRunLookups).toEqual([]);
  });

  it('a lookup that fails or hangs lets the rep in — a DB hiccup must never keep a rep out of their room', async () => {
    state.liveRuns = [{ id: OTHER_ID, status: 'active' }]; // would refuse, if read
    state.liveRunsThrows = true;
    expect((await join(REP_FROM, REP_CALL_SID, SESSION_ID)).body).toContain('<Conference');
    state.liveRunsThrows = false;
    state.liveRunsHang = true;
    _setRejoinDbTimeoutForTests(30);
    expect((await join(REP_FROM, REP_CALL_SID, SESSION_ID)).body).toContain('<Conference');
  });
});
```

- [ ] **Step 30: Run to verify they fail**

Run: `cd services/cti-api && npx vitest run src/routes/telephony-voice-conference.test.ts`
Expected: FAIL. The stale-tab and ended-run tests get `<Conference` instead of `<Reject/>`, and the lookup test finds no lookups. Every pre-existing test in the file still passes.

- [ ] **Step 31: Implement** in `services/cti-api/src/routes/telephony.ts`. Add the import after line 25:

```ts
import { mayJoinNamedRun } from '../dialer/join-guard.js';
```

Add this function after `legShouldRejoin` (after its closing `}`):

```ts
/**
 * The named-join guard (spec 2026-09-26 decision 6; see dialer/join-guard.ts):
 * read the rep's live runs and ask `mayJoinNamedRun`. A leg that names no run
 * (an older softphone) is let in exactly as before. A read that fails or hangs
 * lets the rep in — a database hiccup must never keep a rep out of their room
 * (the same rule as `legShouldRejoin`); the mistake that guards against needs a
 * stale tab AND a database outage at once.
 */
async function dialerJoinAllowed(from: string, sessionId: string | undefined): Promise<boolean> {
  const userId = repUserIdFromClientIdentity(from);
  if (!userId || !sessionId || !UUID_RE.test(sessionId)) return true;
  const decide = async (): Promise<boolean> => {
    const live = await getDb().query.dialerSessions.findMany({
      where: and(eq(schema.dialerSessions.userId, userId), inArray(schema.dialerSessions.status, ['active', 'paused'])),
      columns: { id: true, status: true },
    });
    return mayJoinNamedRun(sessionId, live);
  };
  try {
    return await orDefaultAfter(decide(), true);
  } catch (err) {
    console.error('[dialer] join guard lookup failed; letting the rep in', { userId, err: (err as Error).message });
    return true;
  }
}
```

In the `/voice` `DialerConference` branch, replace:

```ts
      await stampRepCallSid(body.From ?? '', body.CallSid, body.DialerSessionId);
      return reply.type('text/xml').send(twiml);
```

with:

```ts
      // A leg that names a run must be joining the run that owns the rep's room
      // — never a stale tab's paused or finished run while another is live.
      // <Reject/> never answers, so the softphone (apps/cti-web dialer-leg.ts
      // `legAccepted`) sees the join fail instead of a live leg; nothing is
      // stamped, so the live run's recorded leg is untouched.
      if (!(await dialerJoinAllowed(body.From ?? '', body.DialerSessionId))) {
        const response = new twilio.twiml.VoiceResponse();
        response.reject();
        return reply.type('text/xml').send(response.toString());
      }
      await stampRepCallSid(body.From ?? '', body.CallSid, body.DialerSessionId);
      return reply.type('text/xml').send(twiml);
```

- [ ] **Step 32: Run to verify they pass**

Run: `cd services/cti-api && npx vitest run src/routes/telephony-voice-conference.test.ts src/dialer/join-guard.test.ts`
Expected: PASS for every test in both files.

- [ ] **Step 33: Commit**

```bash
git add services/cti-api/src/dialer/join-guard.ts services/cti-api/src/dialer/join-guard.test.ts services/cti-api/src/routes/telephony.ts services/cti-api/src/routes/telephony-voice-conference.test.ts
git commit -F - <<'EOF'
feat(telephony): refuse a named dialer join when another run owns the room

A leg naming a run joins only if that run is live and no other run of
the rep's is active; otherwise <Reject/> and nothing is stamped. A
lookup failure lets the rep in. Resume after a callback re-joins a
paused run this way before it resumes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 34: Full API + firewall verification**

Run: `npm run build:packages && (cd services/cti-api && npx vitest run && npx tsc -p tsconfig.json --noEmit) && (cd packages/firewall && npx vitest run)`
Expected: every cti-api and firewall test passes, and `tsc` prints nothing.

---

### Task 2: Web core: the Device flag, routing a callback during a run, Pause & answer, cancel handling, the heartbeat

**Files:**
- Create: `apps/cti-web/src/callback-waiting.ts`, `apps/cti-web/src/callback-waiting.test.ts`
- Create: `apps/cti-web/src/parked-heartbeat.ts`, `apps/cti-web/src/parked-heartbeat.test.ts`
- Create: `apps/cti-web/src/App.callback-waiting.test.tsx`, `apps/cti-web/src/components/DialerPanel.callback.test.tsx`
- Modify: `apps/cti-web/src/dialer-api.ts` (append), `apps/cti-web/src/dialer-api.test.ts`
- Modify: `apps/cti-web/src/components/DialerPanel.tsx`: props (`:445-489`), destructure (`:755`), `pollOnce` (`:839-840`), imports (`:33`)
- Modify: `apps/cti-web/src/App.tsx` (edits listed step by step below)
- Modify: `apps/cti-web/src/App.test.tsx` (append one test)

**Interfaces:**
- Consumes (Task 1): `POST /dialer/sessions/:id/take-callback`, with its 200 and 409 bodies as specified in Task 1.
- Produces:
  - `apps/cti-web/src/dialer-api.ts`: `export async function takeDialerCallback(id: string): Promise<{ ok: true; action: string; canceledItemId?: string | null }>`
  - `apps/cti-web/src/callback-waiting.ts`:
    - Types: `export type ToastSpec = { text: string; type: 'info' | 'error' | 'success' }`; `export interface RunSnapshot { sessionId: string; sessionStatus: DialerSession['status']; itemStatus: string | null; prospectEndedAt: string | null }`; `export type IncomingRoute = 'ring' | 'wait' | 'reject' | 'reject-talking'`; `export interface IncomingContext { placing: boolean; phase: string; legLive: boolean; legSessionId: string | null; waiting: boolean; snapshot: RunSnapshot | null }`; `export interface WaitingCallback<C extends IncomingCallLike = IncomingCallLike> { id: string; call: C; callerLabel: string; recordType?: string }`; `export type MissedReason = 'on-call' | 'not-paused'`; `export type PauseAndAnswerOutcome = 'answered' | 'talking' | 'caller-gone' | 'failed'`; `export interface PauseAndAnswerDeps`.
    - Functions: `export function runSnapshotOf(view: DialerSessionView): RunSnapshot`; `export function isTalking(s: RunSnapshot | null): boolean`; `export function routeIncoming(c: IncomingContext): IncomingRoute`; `export function callerLabelOf(call: IncomingCallLike): string`; `export function missedCallbackToast(callerLabel: string, forwardE164: string | null, reason?: MissedReason): ToastSpec`; `export function takeCallbackRefusal(e: unknown): 'talking' | 'failed'`; `export async function runPauseAndAnswer(deps: PauseAndAnswerDeps): Promise<PauseAndAnswerOutcome>`.
    - Constants: `CALLER_HUNG_UP_TEXT`, `PARKED_AFTER_DROP_TEXT`.
  - `apps/cti-web/src/parked-heartbeat.ts`: `export const PARKED_HEARTBEAT_MS = 60_000`; `export const HEARTBEAT_FAILURES_BEFORE_WARNING = 5`; `export const HEARTBEAT_UNREACHABLE_TEXT`; `export interface ParkedHeartbeatDeps`; `export function startParkedHeartbeat(sessionId: string, deps: ParkedHeartbeatDeps): () => void`.
  - `DialerPanel` prop: `onRunSnapshot?: (snapshot: RunSnapshot) => void`.
  - App.tsx internals Task 3 uses:
    - State: `callbackWaiting: WaitingCallback<TwilioIncomingCall> | null`; `takingCallback: boolean`.
    - Callbacks: `pauseAndAnswer(): Promise<void>`; `ignoreCallback(): void`; `handleRunSnapshot(snapshot: RunSnapshot): void`; `setParked(id: string | null): void`.
    - Refs: `parkedRunIdRef: MutableRefObject<string | null>`; `legSessionIdRef: MutableRefObject<string | null>`.
    - `joinLeg` still has the signature `(recoveringSessionId?: string | null) => Promise<boolean>`.

#### 2a. Pure decisions: `callback-waiting.ts`

- [ ] **Step 1: Write the failing tests.** Create `apps/cti-web/src/callback-waiting.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  CALLER_HUNG_UP_TEXT,
  callerLabelOf,
  isTalking,
  missedCallbackToast,
  routeIncoming,
  runPauseAndAnswer,
  runSnapshotOf,
  takeCallbackRefusal,
  type IncomingContext,
  type PauseAndAnswerDeps,
  type RunSnapshot,
  type ToastSpec,
} from './callback-waiting';
import type { DialerSessionView } from './dialer-api';

const snap = (o: Partial<RunSnapshot> = {}): RunSnapshot => ({
  sessionId: 'sess-1', sessionStatus: 'active', itemStatus: null, prospectEndedAt: null, ...o,
});
const ctx = (o: Partial<IncomingContext> = {}): IncomingContext => ({
  placing: false, phase: 'idle', legLive: true, legSessionId: 'sess-1', waiting: false, snapshot: snap(), ...o,
});

describe('runSnapshotOf — the slice of the poll App keeps', () => {
  it('takes the run id and status, and the current item\'s status and hang-up stamp', () => {
    const view: DialerSessionView = {
      session: { id: 'sess-1', status: 'active' },
      counts: { total: 1, done: 0, connected: 1, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 },
      currentItem: { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: '+16195550100', prospectEndedAt: null },
    };
    expect(runSnapshotOf(view)).toEqual({ sessionId: 'sess-1', sessionStatus: 'active', itemStatus: 'connected', prospectEndedAt: null });
  });
  it('between dials there is no item', () => {
    const view: DialerSessionView = {
      session: { id: 'sess-1', status: 'paused' },
      counts: { total: 1, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 1 },
      currentItem: null,
    };
    expect(runSnapshotOf(view)).toEqual({ sessionId: 'sess-1', sessionStatus: 'paused', itemStatus: null, prospectEndedAt: null });
  });
});

describe('isTalking — the same rule the server 409s on', () => {
  it('a connected prospect still on the line', () => {
    expect(isTalking(snap({ itemStatus: 'connected' }))).toBe(true);
  });
  it('not once the prospect hung up, not while a dial rings, not between dials, not with no snapshot', () => {
    expect(isTalking(snap({ itemStatus: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }))).toBe(false);
    expect(isTalking(snap({ itemStatus: 'dialing' }))).toBe(false);
    expect(isTalking(snap())).toBe(false);
    expect(isTalking(null)).toBe(false);
  });
});

describe('routeIncoming — no dialer leg on the line: exactly today', () => {
  it('rings when the phone is idle or in preflight', () => {
    expect(routeIncoming(ctx({ legLive: false }))).toBe('ring');
    expect(routeIncoming(ctx({ legLive: false, phase: 'preflight' }))).toBe('ring');
  });
  it('rejects while a manual call rings, is up, is in wrap-up, or is being placed', () => {
    for (const phase of ['ringing', 'active', 'wrapup']) expect(routeIncoming(ctx({ legLive: false, phase }))).toBe('reject');
    expect(routeIncoming(ctx({ legLive: false, placing: true }))).toBe('reject');
  });
});

describe('routeIncoming — during a run (the leg is live)', () => {
  it('talking to a prospect → rejected, with the missed-callback toast', () => {
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'connected' }) }))).toBe('reject-talking');
  });
  it('a dial ringing, between dials, paused, or a prospect who hung up → waits on the banner', () => {
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'dialing' }) }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap() }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ sessionStatus: 'paused' }) }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ itemStatus: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }) }))).toBe('wait');
  });
  it('no snapshot yet, or one of ANOTHER run (the handoff seam) → waits: the server has the last word', () => {
    expect(routeIncoming(ctx({ snapshot: null }))).toBe('wait');
    expect(routeIncoming(ctx({ snapshot: snap({ sessionId: 'sess-2', itemStatus: 'connected' }) }))).toBe('wait');
  });
  it('one callback at a time: a second while one waits is rejected', () => {
    expect(routeIncoming(ctx({ waiting: true }))).toBe('reject');
  });
  it('the busy rule still comes first (a Device error left the phone mid-call)', () => {
    expect(routeIncoming(ctx({ phase: 'active' }))).toBe('reject');
  });
});

describe('callerLabelOf', () => {
  it('the matched Salesforce name, else the formatted number, else "Unknown caller"', () => {
    expect(callerLabelOf({ parameters: { From: '+16195551234' }, customParameters: new Map([['callerName', 'Jane Doe']]) })).toBe('Jane Doe');
    expect(callerLabelOf({ parameters: { From: '+16195551234' }, customParameters: new Map() })).toBe('+1 (619) 555-1234');
    expect(callerLabelOf({})).toBe('Unknown caller');
  });
});

describe('missedCallbackToast — where the rejected callback went', () => {
  it('voicemail with no forward set; "your cell" with one', () => {
    expect(missedCallbackToast('Jane Doe', null)).toEqual({ text: 'Missed callback from Jane Doe — you were on a call. It went to voicemail.', type: 'info' });
    expect(missedCallbackToast('Jane Doe', '+16195550199')).toEqual({ text: 'Missed callback from Jane Doe — you were on a call. It went to your cell.', type: 'info' });
  });
  it('says so when the run could not be paused', () => {
    expect(missedCallbackToast('+1 (619) 555-1234', null, 'not-paused').text).toBe("Missed callback from +1 (619) 555-1234 — Power Dial couldn't pause your run. It went to voicemail.");
  });
});

describe('takeCallbackRefusal — the 409 contract', () => {
  it('only 409 with reason "connected" means the rep is talking', () => {
    expect(takeCallbackRefusal(new ApiError(409, { error: 'x', reason: 'connected' }))).toBe('talking');
    expect(takeCallbackRefusal(new ApiError(409, { error: 'x' }))).toBe('failed');
    expect(takeCallbackRefusal(new ApiError(500, { error: 'x' }))).toBe('failed');
    expect(takeCallbackRefusal(new TypeError('Failed to fetch'))).toBe('failed');
  });
});

describe('runPauseAndAnswer — pause first, then leave the room, then answer', () => {
  function make(calls: string[], toasts: ToastSpec[], o: Partial<PauseAndAnswerDeps> = {}): PauseAndAnswerDeps {
    return {
      takeCallback: async () => { calls.push('takeCallback'); },
      stillRinging: () => { calls.push('stillRinging'); return true; },
      leaveRoom: () => { calls.push('leaveRoom'); },
      clear: () => { calls.push('clear'); },
      reject: () => { calls.push('reject'); },
      accept: () => { calls.push('accept'); },
      toast: (t) => { toasts.push(t); },
      missedToast: () => missedCallbackToast('Jane Doe', null),
      ...o,
    };
  }

  it('in this order and no other: server pause, still ringing?, leave the room, banner down, answer', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    expect(await runPauseAndAnswer(make(calls, toasts))).toBe('answered');
    expect(calls).toEqual(['takeCallback', 'stillRinging', 'leaveRoom', 'clear', 'accept']);
    expect(toasts).toEqual([]);
  });

  it('409 connected — a prospect answered in the race: reject with the missed toast; never leave the room, never answer', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new ApiError(409, { error: 'x', reason: 'connected' }); } });
    expect(await runPauseAndAnswer(d)).toBe('talking');
    expect(calls).toEqual(['reject']);
    expect(toasts).toEqual([{ text: 'Missed callback from Jane Doe — you were on a call. It went to voicemail.', type: 'info' }]);
  });

  it('any other failure: say why and touch nothing — the banner stays so the rep can retry or Ignore', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new ApiError(500, { error: 'database unavailable' }); } });
    expect(await runPauseAndAnswer(d)).toBe('failed');
    expect(calls).toEqual([]);
    expect(toasts).toEqual([{ text: "Couldn't pause the run to answer: database unavailable", type: 'error' }]);
  });

  it('a network failure names itself', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { takeCallback: async () => { throw new TypeError('Failed to fetch'); } });
    expect(await runPauseAndAnswer(d)).toBe('failed');
    expect(toasts).toEqual([{ text: "Couldn't pause the run to answer: Failed to fetch", type: 'error' }]);
  });

  it('the caller hung up during the round trip: banner down and the toast — the rep stays in the room of the now-paused run', async () => {
    const calls: string[] = []; const toasts: ToastSpec[] = [];
    const d = make(calls, toasts, { stillRinging: () => { calls.push('stillRinging'); return false; } });
    expect(await runPauseAndAnswer(d)).toBe('caller-gone');
    expect(calls).toEqual(['takeCallback', 'stillRinging', 'clear']);
    expect(toasts).toEqual([{ text: CALLER_HUNG_UP_TEXT, type: 'info' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/callback-waiting.test.ts`
Expected: FAIL, with `Failed to resolve import "./callback-waiting"`.

- [ ] **Step 3: Implement.** Create `apps/cti-web/src/callback-waiting.ts`:

```ts
/**
 * Callback waiting during a power-dial run — the softphone's decisions (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 *
 * WHY: the rep's conference leg is an active call, so a callback to their own
 * numbers used to be dropped by the SDK in 0 s while they power dialed. The
 * Device now takes calls while busy (App.tsx ensureDevice); this module decides
 * what each one does, and runs the Pause & answer sequence. Pure apart from the
 * injected deps, so App.tsx only wires it.
 */
import { ApiError } from './api';
import type { DialerSession, DialerSessionView } from './dialer-api';
import { formatE164 } from './format';
import { getIncomingCallerInfo, type IncomingCallLike } from './incoming-accept';

/** App's toast, as a value. */
export type ToastSpec = { text: string; type: 'info' | 'error' | 'success' };

export const CALLER_HUNG_UP_TEXT = 'The caller hung up before you answered.';
export const PARKED_AFTER_DROP_TEXT = 'Power Dial lost its audio connection, so the run is paused. Press Resume to continue.';

/** The slice of DialerPanel's latest poll App keeps (spec decision 3). */
export interface RunSnapshot {
  sessionId: string;
  sessionStatus: DialerSession['status'];
  /** The in-flight item's status (dialing / connected), or null between dials. */
  itemStatus: string | null;
  prospectEndedAt: string | null;
}

export function runSnapshotOf(view: DialerSessionView): RunSnapshot {
  return {
    sessionId: view.session.id,
    sessionStatus: view.session.status,
    itemStatus: view.currentItem?.status ?? null,
    prospectEndedAt: view.currentItem?.prospectEndedAt ?? null,
  };
}

/** Talking = the current item is connected and the prospect has not hung up
 *  (decision 3) — the same rule the server's take-callback 409s on. */
export function isTalking(s: RunSnapshot | null): boolean {
  return s?.itemStatus === 'connected' && !s.prospectEndedAt;
}

/**
 * Where an incoming call goes:
 *  - `ring`   — today's ring screen;
 *  - `wait`   — the Power Dial banner (Pause & answer / Ignore);
 *  - `reject` — forward or voicemail, silently, as a busy rep's callback always went;
 *  - `reject-talking` — the same, plus a toast saying so.
 */
export type IncomingRoute = 'ring' | 'wait' | 'reject' | 'reject-talking';

export interface IncomingContext {
  /** An outbound dial is being placed (App's placingRef). */
  placing: boolean;
  /** App's phase: idle | preflight | ringing | active | wrapup. */
  phase: string;
  /** This tab holds a dialer conference leg (App's dialerConnRef). */
  legLive: boolean;
  /** The run that leg belongs to. */
  legSessionId: string | null;
  /** A callback is already waiting on the banner. */
  waiting: boolean;
  /** DialerPanel's latest poll, lifted to App. */
  snapshot: RunSnapshot | null;
}

export function routeIncoming(c: IncomingContext): IncomingRoute {
  // Today's busy rule, first and unchanged: a manual call up, ringing, in
  // wrap-up, or being placed.
  if (c.placing || (c.phase !== 'idle' && c.phase !== 'preflight')) return 'reject';
  // No run on the line: exactly today's ring screen.
  if (!c.legLive) return 'ring';
  // One callback at a time.
  if (c.waiting) return 'reject';
  // A snapshot of another run (the Salesforce handoff seam can swap the
  // panel's run mid-run), or none yet, is unknown: show the banner and let
  // take-callback's 409 decide.
  const snap = c.snapshot && c.snapshot.sessionId === c.legSessionId ? c.snapshot : null;
  return isTalking(snap) ? 'reject-talking' : 'wait';
}

/** A callback on the banner. */
export interface WaitingCallback<C extends IncomingCallLike = IncomingCallLike> {
  /** Stable per call (the CallSid) — keys the banner, so each callback chimes once. */
  id: string;
  call: C;
  /** The matched Salesforce name, else the formatted number. */
  callerLabel: string;
  recordType?: string;
}

export function callerLabelOf(call: IncomingCallLike): string {
  const info = getIncomingCallerInfo(call);
  return info.callerName?.trim() || formatE164(info.from) || 'Unknown caller';
}

export type MissedReason = 'on-call' | 'not-paused';

/** The toast for a callback the softphone rejected. It went where a busy
 *  rep's callback always went: the Settings forward, else voicemail. */
export function missedCallbackToast(callerLabel: string, forwardE164: string | null, reason: MissedReason = 'on-call'): ToastSpec {
  const where = forwardE164 ? 'your cell' : 'voicemail';
  const why = reason === 'on-call' ? 'you were on a call' : "Power Dial couldn't pause your run";
  return { text: `Missed callback from ${callerLabel} — ${why}. It went to ${where}.`, type: 'info' };
}

/** take-callback's 409 contract: `{ reason: 'connected' }` means a prospect is
 *  on the line (and the server changed nothing). Anything else is a failure. */
export function takeCallbackRefusal(e: unknown): 'talking' | 'failed' {
  if (e instanceof ApiError && e.status === 409 && (e.data as { reason?: unknown } | null)?.reason === 'connected') return 'talking';
  return 'failed';
}

function failureText(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = (e.data as { error?: unknown } | null)?.error;
    if (typeof msg === 'string') return msg;
  }
  return e instanceof Error ? e.message : 'unknown error';
}

export interface PauseAndAnswerDeps {
  /** POST take-callback for the run the leg belongs to. */
  takeCallback: () => Promise<unknown>;
  /** The waiting callback is still this call, and still ringing. */
  stillRinging: () => boolean;
  /** Clear the dialer ref, then disconnect the leg; park the run. */
  leaveRoom: () => void;
  /** Take the banner down without touching the call. */
  clear: () => void;
  /** Reject the callback (forward/voicemail) and take the banner down. */
  reject: () => void;
  /** Answer through the normal inbound path (App's acceptCall). */
  accept: () => void;
  toast: (t: ToastSpec) => void;
  missedToast: () => ToastSpec;
}

export type PauseAndAnswerOutcome = 'answered' | 'talking' | 'caller-gone' | 'failed';

/**
 * Pause & answer, in this order and no other (spec decisions 4-5):
 *  1. the server pauses the run FIRST (and cancels a dial still ringing);
 *  2. only then does the rep leave the room — the ref cleared before
 *     disconnect(), so the leg's drop recovery never fires;
 *  3. only then is the callback answered, through the normal inbound path.
 * A 409 means a prospect answered in the race: the rep is talking, so the
 * callback is rejected with the toast and the leg is never touched. Any other
 * failure touches nothing and says why; the banner stays up. A caller who hung
 * up during the round trip leaves the rep in the room of the now-paused run.
 */
export async function runPauseAndAnswer(deps: PauseAndAnswerDeps): Promise<PauseAndAnswerOutcome> {
  try {
    await deps.takeCallback();
  } catch (e) {
    if (takeCallbackRefusal(e) === 'talking') {
      deps.reject();
      deps.toast(deps.missedToast());
      return 'talking';
    }
    deps.toast({ text: `Couldn't pause the run to answer: ${failureText(e)}`, type: 'error' });
    return 'failed';
  }
  if (!deps.stillRinging()) {
    deps.clear();
    deps.toast({ text: CALLER_HUNG_UP_TEXT, type: 'info' });
    return 'caller-gone';
  }
  deps.leaveRoom();
  deps.clear();
  deps.accept();
  return 'answered';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/callback-waiting.test.ts`
Expected: PASS for every test in the file.

#### 2b. The heartbeat

- [ ] **Step 5: Write the failing tests.** Create `apps/cti-web/src/parked-heartbeat.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_FAILURES_BEFORE_WARNING, PARKED_HEARTBEAT_MS, startParkedHeartbeat, type ParkedHeartbeatDeps } from './parked-heartbeat';
import type { DialerSession } from './dialer-api';

type Status = DialerSession['status'];
const ok = (status: Status) => async () => ({ session: { status } });

function deps(poll: ParkedHeartbeatDeps['poll']) {
  return { poll: vi.fn(poll), onRunOver: vi.fn(), onUnreachable: vi.fn() };
}

describe('startParkedHeartbeat — keeps a run parked for a callback from being reaped', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("polls the parked run once a minute — well inside the reaper's ten", async () => {
    expect(PARKED_HEARTBEAT_MS).toBe(60_000);
    const d = deps(ok('paused'));
    const stop = startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS - 1);
    expect(d.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.poll).toHaveBeenCalledWith('sess-1');
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    expect(d.poll).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops — and hands the run back to be released — the first time the run reads as over', async () => {
    for (const status of ['done', 'stopped'] as const) {
      const d = deps(ok(status));
      startParkedHeartbeat('sess-1', d);
      await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 3);
      expect(d.poll).toHaveBeenCalledTimes(1);
      expect(d.onRunOver).toHaveBeenCalledTimes(1);
    }
  });

  it('stop() ends it', async () => {
    const d = deps(ok('paused'));
    startParkedHeartbeat('sess-1', d)();
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 2);
    expect(d.poll).not.toHaveBeenCalled();
  });

  it('tells the rep ONCE after five straight failures (half the reaper window); a success resets the count', async () => {
    expect(HEARTBEAT_FAILURES_BEFORE_WARNING).toBe(5);
    const d = deps(async () => { throw new Error('offline'); });
    startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 4);
    expect(d.onUnreachable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    expect(d.onUnreachable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 3);
    expect(d.onUnreachable).toHaveBeenCalledTimes(1);

    let fail = true;
    let n = 0;
    const d2 = deps(async () => { n++; if (n === 5) fail = false; else fail = true; if (fail) throw new Error('offline'); return { session: { status: 'paused' as Status } }; });
    startParkedHeartbeat('sess-2', d2);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 9); // fail ×4, ok, fail ×4
    expect(d2.onUnreachable).not.toHaveBeenCalled();
  });

  it('a beat still in flight when stop() is called does nothing when it lands', async () => {
    let land: (v: { session: { status: Status } }) => void = () => {};
    const d = deps(() => new Promise((r) => { land = r; }));
    const stop = startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    stop();
    land({ session: { status: 'done' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.onRunOver).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/parked-heartbeat.test.ts`
Expected: FAIL, with `Failed to resolve import "./parked-heartbeat"`.

- [ ] **Step 7: Implement.** Create `apps/cti-web/src/parked-heartbeat.ts`:

```ts
/**
 * The heartbeat for a run parked while the rep takes a callback (spec
 * 2026-09-26 decision 7). The Power Dial panel — the run's usual poller — is
 * off screen during the call, and the reaper (services/cti-api
 * salesforce/followup-worker.ts `expireAbandonedSessions`) stops a paused run
 * nobody has polled for ten minutes. A GET of the session is the poll that
 * counts (it stamps `last_polled_at`).
 */
import type { DialerSession } from './dialer-api';

export const PARKED_HEARTBEAT_MS = 60_000;
/** Consecutive failed beats before the rep is told: five minutes of silence is
 *  half the reaper's window. */
export const HEARTBEAT_FAILURES_BEFORE_WARNING = 5;
export const HEARTBEAT_UNREACHABLE_TEXT = "Can't reach the server — your paused Power Dial run may be stopped if this goes on. Check your connection.";

export interface ParkedHeartbeatDeps {
  poll: (sessionId: string) => Promise<{ session: Pick<DialerSession, 'status'> }>;
  /** The run reads as done or stopped: release it (App's dropConferenceLeg). */
  onRunOver: () => void;
  /** HEARTBEAT_FAILURES_BEFORE_WARNING beats in a row failed — once per streak. */
  onUnreachable: () => void;
}

/** Beat every PARKED_HEARTBEAT_MS until the returned stop() is called or the
 *  run reads as over. A single failed beat is retried by the next one. */
export function startParkedHeartbeat(sessionId: string, deps: ParkedHeartbeatDeps): () => void {
  let stopped = false;
  let failures = 0;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const beat = async (): Promise<void> => {
    try {
      const view = await deps.poll(sessionId);
      failures = 0;
      if (stopped) return;
      if (view.session.status === 'done' || view.session.status === 'stopped') {
        stop();
        deps.onRunOver();
      }
    } catch {
      failures++;
      if (!stopped && failures === HEARTBEAT_FAILURES_BEFORE_WARNING) deps.onUnreachable();
    }
  };
  const timer = setInterval(() => { void beat(); }, PARKED_HEARTBEAT_MS);
  return stop;
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/parked-heartbeat.test.ts`
Expected: PASS, 5 tests.

#### 2c. `takeDialerCallback`, and DialerPanel hands its poll to App

- [ ] **Step 9: Write the failing tests.** In `apps/cti-web/src/dialer-api.test.ts`, change line 2 to:

```ts
import { dialerControlPath, startBody, startDialer, getDialer, dialerControl, getPendingHandoff, takeDialerCallback } from './dialer-api';
```

and add inside `describe('dialer-api async functions', ...)`:

```ts
  it('takeDialerCallback POSTs /dialer/sessions/:id/take-callback', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ ok: true, action: 'paused', canceledItemId: null });
    expect(await takeDialerCallback('sess1')).toEqual({ ok: true, action: 'paused', canceledItemId: null });
    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/sess1/take-callback', { method: 'POST' });
  });
```

Create `apps/cti-web/src/components/DialerPanel.callback.test.tsx`:

```tsx
/** @vitest-environment jsdom */
/**
 * DialerPanel's side of callback waiting (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md): it hands App a
 * run snapshot on every poll (Task 2); in Task 3 it also shows the banner,
 * re-joins before Resume, and screen-pops once per record across remounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, type DialerPanelProps } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import type { DialerCurrentItem, DialerSession, DialerSessionView } from '../dialer-api';

const view = (o: { sessionStatus?: DialerSession['status']; item?: Partial<DialerCurrentItem> | null } = {}): DialerSessionView => ({
  session: { id: 'sess1', status: o.sessionStatus ?? 'active' },
  counts: { total: 2, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 2 },
  currentItem: o.item === null
    ? null
    : { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'dialing', toNumber: '+16195551234', ...(o.item ?? {}) },
  rollovers: { moved: 0, pushed: 0, failed: 0, pending: 0 },
});

const noop = (): void => {};
function mount(extra: Partial<DialerPanelProps> = {}) {
  return render(
    <DialerPanel sessionId="sess1" onScreenPop={noop} onStartFromListView={async () => {}} onPrepare={async () => {}} onJoin={async () => true} onStop={noop} onComplete={noop} onDismiss={noop} {...extra} />,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DialerPanel — the lifted run snapshot (Task 2)', () => {
  it('hands every successful poll to onRunSnapshot — the slice App judges "talking" by', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected', prospectEndedAt: null } }));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(onRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess1', sessionStatus: 'active', itemStatus: 'connected', prospectEndedAt: null }));
  });

  it('between dials the snapshot has no item', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(onRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess1', sessionStatus: 'paused', itemStatus: null, prospectEndedAt: null }));
  });

  it('a failed poll hands nothing over — the last good snapshot stands', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockRejectedValue(new Error('offline'));
    const onRunSnapshot = vi.fn();
    mount({ onRunSnapshot });
    await waitFor(() => expect(dialerApi.getDialer).toHaveBeenCalled());
    await new Promise((r) => { setTimeout(r, 20); });
    expect(onRunSnapshot).not.toHaveBeenCalled();
  });
});
```

(`fireEvent` and `screen` are for the Task 3 tests appended to this file.)

- [ ] **Step 10: Run to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/dialer-api.test.ts src/components/DialerPanel.callback.test.tsx`
Expected: FAIL. `takeDialerCallback is not a function`, and `onRunSnapshot` is never called.

- [ ] **Step 11: Implement.** Append to `apps/cti-web/src/dialer-api.ts`:

```ts
/** Pause & answer (spec 2026-09-26-callback-waiting-design.md): the server
 *  pauses the run — cancelling a dial still ringing — before the softphone
 *  leaves the room. Throws ApiError 409 `{ reason: 'connected' }` when a
 *  prospect is on the line (nothing was changed). */
export async function takeDialerCallback(id: string): Promise<{ ok: true; action: string; canceledItemId?: string | null }> {
  return api(`/dialer/sessions/${id}/take-callback`, { method: 'POST' });
}
```

In `apps/cti-web/src/components/DialerPanel.tsx`, add after `import { YouTubeHoldPlayer } from './YouTubeHoldPlayer';`:

```ts
import { runSnapshotOf, type RunSnapshot } from '../callback-waiting';
```

In `DialerPanelProps`, replace:

```ts
  lineAudio?: LineAudio;
}

/**
 * The YouTube hold player
```

with:

```ts
  lineAudio?: LineAudio;
  /** Every successful poll, as the slice App keeps (spec 2026-09-26 decision
   *  3): App decides whether a callback that rings now finds the rep talking. */
  onRunSnapshot?: (snapshot: RunSnapshot) => void;
}

/**
 * The YouTube hold player
```

Replace the destructure line:

```ts
  const { sessionId, onScreenPop, onStartFromListView, onPrepare, onJoin, onStop, onComplete, onDismiss, holdMusic, lineAudio } = props;
```

with:

```ts
  const { sessionId, onScreenPop, onStartFromListView, onPrepare, onJoin, onStop, onComplete, onDismiss, holdMusic, lineAudio, onRunSnapshot } = props;
```

In `pollOnce`, replace:

```ts
        setView(next);
        setError(null);
```

with:

```ts
        setView(next);
        setError(null);
        onRunSnapshot?.(runSnapshotOf(next));
```

- [ ] **Step 12: Run to verify they pass**

Run: `cd apps/cti-web && npx vitest run src/dialer-api.test.ts src/components/DialerPanel.callback.test.tsx`
Expected: PASS for every test in both files.

#### 2d. App wiring

- [ ] **Step 13: Write the failing App tests.** Create `apps/cti-web/src/App.callback-waiting.test.tsx`:

```tsx
/** @vitest-environment jsdom */
/**
 * Pins App.tsx's WIRING of callback waiting during a power-dial run (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md). The decisions
 * are pinned in callback-waiting.test.ts / parked-heartbeat.test.ts; this
 * proves the call sites: the Device flag, where an incoming call goes during a
 * run, the dropped-leg hand-off, and (Task 3) the banner, Pause & answer and
 * Resume. Harness idiom: App.dialer-leg.test.tsx — real App, fake Twilio SDK,
 * fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import * as opencti from './opencti';
import * as heartbeat from './parked-heartbeat';

type Listener = (...args: unknown[]) => void;

class FakeTrack {
  private handlers = new Map<string, Array<() => void>>();
  addEventListener(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
}

/** The rep's dialer conference leg (device.connect()'s return value). */
class FakeConnection {
  private handlers = new Map<string, Listener[]>();
  disconnect = vi.fn(() => { state.events.push('leg-disconnect'); this.emit('disconnect'); });
  micTrack = new FakeTrack();
  getLocalStream(): { getAudioTracks: () => FakeTrack[] } { return { getAudioTracks: () => [this.micTrack] }; }
  on(event: string, cb: Listener): void { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
  emit(event: string): void { for (const cb of this.handlers.get(event) ?? []) cb(); }
  hasListenerFor(event: string): boolean { return (this.handlers.get(event)?.length ?? 0) > 0; }
}

class FakeDevice {
  static instances: FakeDevice[] = [];
  static connects: Array<{ params: Record<string, string>; connection: FakeConnection }> = [];
  static lastOpts: Record<string, unknown> | null = null;
  /** Hold connect() open this long — so a callback can ring while the leg joins. */
  static connectDelayMs = 0;
  private listeners = new Map<string, Listener[]>();
  audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }]]),
    inputDevice: null as { deviceId: string } | null,
    setInputDevice: vi.fn(async () => {}),
    on: vi.fn(),
  };
  constructor(_token: string, opts: Record<string, unknown>) {
    FakeDevice.lastOpts = opts;
    FakeDevice.instances.push(this);
  }
  on(event: string, cb: Listener): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]); }
  emit(event: string, arg?: unknown): void { for (const cb of this.listeners.get(event) ?? []) cb(arg); }
  register(): Promise<void> { return Promise.resolve(); }
  updateToken(): void { /* not exercised */ }
  destroy(): void { /* not exercised */ }
  async connect(opts: { params: Record<string, string> }): Promise<FakeConnection> {
    if (FakeDevice.connectDelayMs) await new Promise((r) => { setTimeout(r, FakeDevice.connectDelayMs); });
    const connection = new FakeConnection();
    FakeDevice.connects.push({ params: opts.params, connection });
    return connection;
  }
}
vi.mock('@twilio/voice-sdk', () => ({ Device: FakeDevice }));

/** A callback ringing the softphone — the SDK's incoming Call, faked. */
interface FakeCall {
  parameters: Record<string, string>;
  customParameters: Map<string, string>;
  accept: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  status: () => string;
  on: (event: string, cb: Listener) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function callbackCall(n = 1): FakeCall {
  const listeners = new Map<string, Listener[]>();
  let status = 'pending';
  return {
    parameters: { From: '+16195551234', CallSid: `CAcallback${n}` },
    customParameters: new Map([['callerName', 'Jane Doe'], ['recordId', '00QCALLBACK000001'], ['recordType', 'Lead']]),
    accept: vi.fn(() => { state.events.push('accept'); status = 'open'; }),
    reject: vi.fn(() => { status = 'closed'; }),
    disconnect: vi.fn(),
    status: () => status,
    on: (event, cb) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]); },
    emit: (event, ...args) => {
      if (event === 'cancel' || event === 'disconnect') status = 'closed';
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

const state = {
  status: 'ready' as 'ready' | 'active' | 'paused' | 'stopped' | 'done',
  /** The run's current item as the poll reports it (null = between dials). */
  currentItem: null as null | { status: string; prospectEndedAt: string | null },
  /** Every dialer control and take-callback the app sent, in order. */
  controls: [] as string[],
  /** Cross-object order: the take-callback POST, the leg disconnect, the accept. */
  events: [] as string[],
  /** How POST take-callback answers. */
  takeCallback: 'ok' as 'ok' | 'connected' | 'error',
  /** The rep's no-answer forward (Settings), from /auth/me. */
  forward: null as string | null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

const VIEW = () => ({
  session: { id: 'sess-1', status: state.status },
  counts: { total: 2, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 2 },
  currentItem: state.currentItem
    ? { id: 'i1', recordId: '00QPROSPECT000001', objectType: 'Lead', toNumber: '+16195550100', ...state.currentItem }
    : null,
  firstPassTotal: 2,
});

beforeEach(() => {
  FakeDevice.instances.length = 0;
  FakeDevice.connects.length = 0;
  FakeDevice.lastOpts = null;
  FakeDevice.connectDelayMs = 0;
  state.status = 'ready';
  state.currentItem = null;
  state.controls = [];
  state.events = [];
  state.takeCallback = 'ok';
  state.forward = null;
  localStorage.clear();
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@example.com' }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.includes('/auth/me')) {
      return jsonResponse({
        user: { userId: 'u1', orgId: 'org1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, noAnswerForwardE164: state.forward },
        salesforce: { connected: true },
      });
    }
    if (url.includes('/calls/pending-disposition')) return jsonResponse({ pending: null });
    if (url.includes('/telephony/token')) return jsonResponse({ token: 'device-token' });
    if (url.includes('/dialer/handoffs/pending')) return jsonResponse({ handoff: null });
    if (url.includes('/dialer/sessions/sess-1/take-callback')) {
      state.controls.push('take-callback');
      state.events.push('take-callback');
      if (state.takeCallback === 'connected') return jsonResponse({ error: 'You are talking to a prospect — finish that call first.', reason: 'connected' }, 409);
      if (state.takeCallback === 'error') return jsonResponse({ error: 'database unavailable' }, 500);
      const canceledItemId = state.currentItem?.status === 'dialing' ? 'i1' : null;
      if (canceledItemId) state.currentItem = null;
      state.status = 'paused';
      return jsonResponse({ ok: true, action: 'paused', canceledItemId });
    }
    const control = /\/dialer\/sessions\/sess-1\/(start|stop|pause|resume|skip|next|redial|end)$/.exec(url);
    if (control) {
      const action = control[1]!;
      state.controls.push(action);
      if (action === 'start' || action === 'resume') state.status = 'active';
      if (action === 'pause') state.status = 'paused';
      if (action === 'stop') state.status = 'stopped';
      if (action === 'next') state.currentItem = null;
      return jsonResponse({ ok: true });
    }
    if (url.includes('/dialer/sessions/sess-1')) return jsonResponse(VIEW());
    if (url.includes('/dialer/sessions') && init?.method === 'POST') return jsonResponse({ sessionId: 'sess-1', total: 2 });
    return jsonResponse({});
  }));
  vi.spyOn(opencti, 'screenPopRecord').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Hand the app a run the way Salesforce does (postMessage). */
function handOverRun(): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: window.parent,
      data: { type: 'POWER_DIAL', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    }));
  });
}

/** Render, hand the app a run, press Start, and wait until the leg is adopted. */
async function startRun(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
  handOverRun();
  fireEvent.click(await screen.findByText('Start dialing'));
  await waitFor(() => expect(FakeDevice.connects.length).toBe(1));
  // watchDialerLeg is attached right after dialerConnRef is set.
  await waitFor(() => expect(FakeDevice.connects[0]!.connection.hasListenerFor('disconnect')).toBe(true));
}

function ring(call: FakeCall): void {
  act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
}

describe('App — callbacks during a power-dial run (Task 2 wiring)', () => {
  it('builds the Twilio Device with allowIncomingWhileBusy — at construction, not via updateOptions', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    expect(FakeDevice.lastOpts).toEqual(expect.objectContaining({ logLevel: 1, allowIncomingWhileBusy: true }));
  });

  it('with no run, a callback rings exactly as today', async () => {
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    const call = callbackCall();
    ring(call);
    expect(await screen.findByTitle('Answer')).toBeTruthy();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('while the rep is talking to a prospect: rejected at once, and a toast says where it went', async () => {
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await startRun();
    await screen.findByText('End call'); // the poll saw the connected item — the snapshot is lifted
    const call = callbackCall();
    ring(call);
    expect(call.reject).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to voicemail.')).toBeTruthy();
    expect(screen.queryByTitle('Answer')).toBeNull();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('…"your cell" when the rep has a no-answer forward set', async () => {
    state.forward = '+16195550199';
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await startRun();
    await screen.findByText('End call');
    ring(callbackCall());
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to your cell.')).toBeTruthy();
  });

  it('while a dial only rings: the callback waits for the rep — not rejected, no ring screen, the run stays on screen', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    expect(call.reject).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Answer')).toBeNull();
    expect(screen.getByText('Stop')).toBeTruthy();
  });

  it('the prospect answers after the callback started waiting: the next poll rejects it, with the toast', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    state.currentItem = { status: 'connected', prospectEndedAt: null };
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(await screen.findByText(/Missed callback from Jane Doe — you were on a call/)).toBeTruthy();
  });

  it('a second callback while one waits is rejected; the first keeps waiting', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const first = callbackCall(1);
    const second = callbackCall(2);
    ring(first);
    ring(second);
    expect(second.reject).toHaveBeenCalledTimes(1);
    expect(first.reject).not.toHaveBeenCalled();
  });

  it('a waiting caller who hangs up frees the slot: the next callback waits too', async () => {
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const first = callbackCall(1);
    ring(first);
    act(() => { first.emit('cancel'); });
    const second = callbackCall(2);
    ring(second);
    expect(second.reject).not.toHaveBeenCalled();
  });

  it('a callback that reached the ring screen while the leg was joining is never answered over the live leg', async () => {
    FakeDevice.connectDelayMs = 300;
    render(<App />);
    await waitFor(() => expect(FakeDevice.instances.length).toBe(1));
    handOverRun();
    fireEvent.click(await screen.findByText('Start dialing'));
    await waitFor(() => expect(state.controls).toContain('start'));
    const call = callbackCall();
    ring(call); // no leg yet → today's ring screen
    const answer = await screen.findByTitle('Answer');
    await waitFor(() => expect(FakeDevice.connects[0]?.connection.hasListenerFor('disconnect')).toBe(true));
    fireEvent.click(answer);
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
    expect(screen.queryByTitle('Answer')).toBeNull();
  });

  it('the leg drops while a callback waits: no re-join (connect() would swallow the ring) — the run is parked, kept alive, and the callback rings the ordinary way', async () => {
    const beat = vi.spyOn(heartbeat, 'startParkedHeartbeat');
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    expect(await screen.findByTitle('Answer')).toBeTruthy();
    expect(state.controls).toContain('take-callback');
    expect(beat).toHaveBeenCalledWith('sess-1', expect.anything());
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(1);
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('…but when the run cannot be paused (a prospect answered: 409), the callback is rejected with the toast and the leg is recovered as usual', async () => {
    state.takeCallback = 'connected';
    state.currentItem = { status: 'dialing', prospectEndedAt: null };
    await startRun();
    await screen.findByText(/Dialing/);
    const call = callbackCall();
    ring(call);
    act(() => { FakeDevice.connects[0]!.connection.emit('disconnect'); });
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Missed callback from Jane Doe — you were on a call/)).toBeTruthy();
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2), { timeout: 4000 });
  }, 15_000);
});
```

Append to `apps/cti-web/src/App.test.tsx`:

```tsx
/** allowIncomingWhileBusy (spec 2026-09-26) now lets a callback reach the app
 *  during a manual call, where the SDK used to drop it. Spec decision 2: the
 *  outcome must stay exactly what it was — rejected (forward/voicemail). */
describe('App — a callback during a manual call', () => {
  it('is rejected at once — no ring screen, no toast — exactly as when the SDK dropped it', async () => {
    stubOutboundFetch();
    await placeOutboundCall();
    const call = fakeCall({ parameters: { From: '+16195550000' }, customParameters: new Map() });
    act(() => { FakeDevice.instances[0]!.emit('incoming', call); });
    expect(call.reject).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle('Answer')).toBeNull();
    expect(screen.queryByText(/Missed callback/)).toBeNull();
  });
});
```

- [ ] **Step 14: Run to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/App.callback-waiting.test.tsx`
Expected: FAIL. The flag test gets `{ logLevel: 1 }`. The talking test finds no reject (the SDK path in the fake delivers the call and App shows the ring screen). The waiting tests see the ring screen instead. The leg-drop test re-joins. The "with no run" test passes.

Run: `cd apps/cti-web && npx vitest run src/App.test.tsx`
Expected: PASS for every test (the manual-call test passes before and after: today's handler already rejects during `ringing`; it is a regression pin for the new flag).

- [ ] **Step 15: Implement in `apps/cti-web/src/App.tsx`, edit by edit.**

(a) In the `import { ... } from './dialer-api';` block, add `takeDialerCallback,` after `startDialerFromListView,`. After `import { acceptIncomingCall, planIncomingAccept } from './incoming-accept';` add:

```ts
import {
  callerLabelOf,
  isTalking,
  missedCallbackToast,
  PARKED_AFTER_DROP_TEXT,
  routeIncoming,
  runPauseAndAnswer,
  takeCallbackRefusal,
  type RunSnapshot,
  type ToastSpec,
  type WaitingCallback,
} from './callback-waiting';
import { HEARTBEAT_UNREACHABLE_TEXT, startParkedHeartbeat } from './parked-heartbeat';
```

(b) After `  const [dialerLive, setDialerLive] = useState(false);` add:

```ts
  // A callback that rang while this tab's dialer leg was up and the rep was
  // not talking to a prospect (spec 2026-09-26-callback-waiting-design.md): it
  // waits on the Power Dial banner, NOT the ring screen — answering it the
  // normal way would let the SDK's beforeAccept disconnect the leg. State for
  // the banner; the ref for synchronous reads in SDK handlers.
  const [callbackWaiting, setCallbackWaitingState] = useState<WaitingCallback<TwilioIncomingCall> | null>(null);
  const callbackWaitingRef = useRef<WaitingCallback<TwilioIncomingCall> | null>(null);
  const setWaiting = useCallback((w: WaitingCallback<TwilioIncomingCall> | null): void => {
    callbackWaitingRef.current = w;
    setCallbackWaitingState(w);
  }, []);
  // True while Pause & answer (or the dropped-leg hand-off) is in flight.
  const [takingCallback, setTakingCallback] = useState(false);
  const takingCallbackRef = useRef(false);
  // The paused run the rep left the room of to take a callback. While set, the
  // tab stays "busy" for the softphone election, the heartbeat keeps the run
  // from being reaped, and Resume re-joins the room before it resumes.
  const [parkedRunId, setParkedRunIdState] = useState<string | null>(null);
  const parkedRunIdRef = useRef<string | null>(null);
  const setParked = useCallback((id: string | null): void => {
    parkedRunIdRef.current = id;
    setParkedRunIdState(id);
  }, []);
  // The run THIS tab's dialer leg belongs to — set when the leg is adopted.
  const legSessionIdRef = useRef<string | null>(null);
  // DialerPanel's latest poll, lifted (decision 3): what "is the rep talking?"
  // is judged by when a callback rings.
  const runSnapshotRef = useRef<RunSnapshot | null>(null);
  // The rep's no-answer forward (Settings): where a rejected callback goes.
  const forwardE164Ref = useRef<string | null>(null);
```

(c) Replace:

```ts
    setPendingDisp(null);
  }, [teardownDevice]);
```

with:

```ts
    setPendingDisp(null);
    setParked(null);
    setWaiting(null);
  }, [teardownDevice, setParked, setWaiting]);
```

(d) After `  useEffect(() => { incomingRef.current = incoming; }, [incoming]);` add:

```ts
  useEffect(() => { forwardE164Ref.current = me?.user.noAnswerForwardE164 ?? null; }, [me]);
```

(e) Immediately before `  // Lazily create + register ONE persistent Twilio device, reused for both`, add:

```ts
  // Today's ring screen for an incoming callback — used when no dialer leg is
  // on the line (spec: a rep with no run in progress sees exactly this).
  const ringNormally = useCallback((call: TwilioIncomingCall): void => {
    // Clear the ringing UI if the caller hangs up or the leg is cancelled
    // (e.g. answered in another tab) before the rep picks up.
    call.on('cancel', () => setIncoming((c) => (c === call ? null : c)));
    call.on('disconnect', () => setIncoming((c) => (c === call ? null : c)));
    setIncoming(call);
    // Pop the softphone panel open (Salesforce utility bar) so the rep sees the
    // ring without hunting for the tab — as long as they're in Salesforce.
    try { setPanelVisibility(true); } catch { /* not embedded in SF */ }
  }, []);

  // A callback during a run while the rep is not talking: it waits on the
  // Power Dial banner (DialerPanel) for Pause & answer or Ignore.
  const waitOnCallback = useCallback((call: TwilioIncomingCall): void => {
    setWaiting({
      id: call.parameters?.CallSid ?? `callback-${Date.now()}`,
      call,
      callerLabel: callerLabelOf(call),
      recordType: call.customParameters?.get('recordType'),
    });
    // The caller hung up, or the rep answered on their iPhone (same identity):
    // the banner goes and the run is untouched.
    const clear = (): void => { if (callbackWaitingRef.current?.call === call) setWaiting(null); };
    call.on('cancel', clear);
    call.on('disconnect', clear);
    try { setPanelVisibility(true); } catch { /* not embedded in SF */ }
  }, [setWaiting]);

  // Reject a waiting callback — Twilio forwards it or takes a voicemail, exactly
  // as a busy rep's callback always went — take the banner down, and optionally
  // tell the rep.
  const rejectWaitingCallback = useCallback((w: WaitingCallback<TwilioIncomingCall>, notice?: ToastSpec): void => {
    if (callbackWaitingRef.current?.call === w.call) setWaiting(null);
    try { w.call.reject(); } catch { /* already gone */ }
    if (notice) setToast(notice);
  }, [setWaiting]);

```

(f) Replace:

```ts
    const device = new Device(tok.token, { logLevel: 1 });
```

with:

```ts
    // allowIncomingWhileBusy: a callback must reach the app while the rep sits
    // on a power-dial run's conference leg — the default drops it silently
    // (busy in 0 s). Set here, never via updateOptions(), which rebuilds the
    // sound cache and loses the ringtone speaker chosen in Settings. The
    // 'incoming' handler below decides what a busy rep's callback does.
    const device = new Device(tok.token, { logLevel: 1, allowIncomingWhileBusy: true });
```

(g) Replace the whole `incoming` handler, from `    // An INBOUND callback dialed to this rep's client identity.` through its closing `    });` (the block ending with `try { setPanelVisibility(true); } catch { /* not embedded in SF */ }` and `    });`), with:

```ts
    // An INBOUND callback dialed to this rep's client identity. Where it goes is
    // callback-waiting.ts `routeIncoming`; with no dialer leg on the line it is
    // exactly today's rule (busy or dialing out → reject, else ring).
    d.on('incoming', (callObj) => {
      const call = callObj as TwilioIncomingCall;
      const route = routeIncoming({
        placing: placingRef.current,
        phase: phaseRef.current,
        legLive: !!dialerConnRef.current,
        legSessionId: legSessionIdRef.current,
        waiting: !!callbackWaitingRef.current,
        snapshot: runSnapshotRef.current,
      });
      if (route === 'ring') { ringNormally(call); return; }
      if (route === 'wait') { waitOnCallback(call); return; }
      // Forward or voicemail, as today; say so when a prospect call is why.
      try { call.reject(); } catch { /* */ }
      if (route === 'reject-talking') setToast(missedCallbackToast(callerLabelOf(call), forwardE164Ref.current));
    });
```

(h) Replace the end of `ensureDevice`:

```ts
      deviceRef.current = null;
      throw err;
    }
  }, [signOut]);
```

with:

```ts
      deviceRef.current = null;
      throw err;
    }
  }, [signOut, ringNormally, waitOnCallback]);
```

(i) Replace `dropConferenceLeg`:

```ts
  const dropConferenceLeg = useCallback(() => {
    dialerRunRef.current++;
    const conn = dialerConnRef.current as { disconnect?: () => void } | null;
    dialerConnRef.current = null;
    if (conn) { try { conn.disconnect?.(); } catch { /* already gone */ } }
    setDialerLive(false);
    if (pendingTeardownRef.current && !connectionRef.current && !incomingRef.current) { pendingTeardownRef.current = false; teardownDevice(); }
  }, [teardownDevice]);
```

with (this adds `leaveRoomForCallback` and `handOffCallbackAfterDrop` after it):

```ts
  const dropConferenceLeg = useCallback(() => {
    dialerRunRef.current++;
    const conn = dialerConnRef.current as { disconnect?: () => void } | null;
    dialerConnRef.current = null;
    legSessionIdRef.current = null;
    if (conn) { try { conn.disconnect?.(); } catch { /* already gone */ } }
    setDialerLive(false);
    setParked(null);
    // A callback still waiting on the banner outlives the run: with no leg
    // left to lose, it rings the ordinary way.
    const waiting = callbackWaitingRef.current;
    if (waiting) { setWaiting(null); ringNormally(waiting.call); }
    if (pendingTeardownRef.current && !connectionRef.current && !incomingRef.current && !waiting) { pendingTeardownRef.current = false; teardownDevice(); }
  }, [teardownDevice, setParked, setWaiting, ringNormally]);

  // Pause & answer's step 2 (spec decision 5): leave the run's room so the
  // callback can be answered on this Device. Unlike dropConferenceLeg the run is
  // PARKED, not over: the nav stays locked on Power Dial, the deferred Device
  // teardown is not flushed (the callback is about to use the Device), and the
  // run id is kept for the heartbeat and Resume. The ref is cleared BEFORE
  // disconnect(), so watchDialerLeg never reads this as a drop; the generation
  // bump supersedes a join or recovery in flight. Twilio then asks the rejoin
  // route with `completed`, which pauses a run take-callback already paused.
  const leaveRoomForCallback = useCallback((sessionId: string): void => {
    dialerRunRef.current++;
    setParked(sessionId); // first: the tab stays "busy" for the election throughout
    const conn = dialerConnRef.current as { disconnect?: () => void } | null;
    dialerConnRef.current = null;
    legSessionIdRef.current = null;
    if (conn) { try { conn.disconnect?.(); } catch { /* already gone */ } }
  }, [setParked]);

  // Spec decision 9: the leg dropped on its own while a callback waited on the
  // banner. Re-joining now would call device.connect(), which silently
  // ignore()s the pending call. So: take-callback (the run pauses and a dial
  // still ringing is cancelled — nobody is in the room to bridge it to), park
  // the run, and let the callback ring the ordinary way; Resume re-joins later.
  // Resolves false — the callback rejected, with a toast — when the run could
  // not be paused; the caller then recovers the leg as usual, because a live
  // run must never keep dialing into an empty room.
  const handOffCallbackAfterDrop = useCallback(async (sessionId: string | null): Promise<boolean> => {
    const waiting = callbackWaitingRef.current;
    if (!waiting || !sessionId || takingCallbackRef.current) return false;
    takingCallbackRef.current = true;
    setTakingCallback(true);
    try {
      await takeDialerCallback(sessionId);
    } catch (e) {
      const reason = takeCallbackRefusal(e) === 'talking' ? 'on-call' : 'not-paused';
      rejectWaitingCallback(waiting, missedCallbackToast(waiting.callerLabel, forwardE164Ref.current, reason));
      return false;
    } finally {
      takingCallbackRef.current = false;
      setTakingCallback(false);
    }
    dialerRunRef.current++;       // nothing may act for the dropped leg any more
    setParked(sessionId);          // before the dead ref goes: the tab stays busy
    dialerConnRef.current = null;
    legSessionIdRef.current = null;
    const stillRinging = callbackWaitingRef.current?.call === waiting.call && waiting.call.status?.() !== 'closed';
    setWaiting(null);
    if (!stillRinging) {
      setToast({ text: PARKED_AFTER_DROP_TEXT, type: 'info' });
      return true;
    }
    ringNormally(waiting.call);
    return true;
  }, [rejectWaitingCallback, ringNormally, setParked, setWaiting]);
```

(j) In `joinLeg`, replace:

```ts
      dialerConnRef.current = connection;
```

with:

```ts
      dialerConnRef.current = connection;
      legSessionIdRef.current = sessionId ?? null;
```

(k) In `joinLeg`, replace the whole `onDropped: () => { ... },` property with:

```ts
        onDropped: () => {
          // The ref is left pointing at the dead leg on purpose: it keeps this tab
          // "busy", so the softphone election cannot move the Device to another
          // tab in the middle of the recovery. `dropped` absorbs a second event.
          dropped = true;
          const recover = (): void => {
            // The run generation this recovery owns. Its own rejoin bumps the
            // counter (synchronously, at the top of joinLeg), so follow it.
            let gen = myRun;
            const isCurrent = (): boolean => dialerRunRef.current === gen;
            void recoverDroppedLeg({
              isCurrent,
              wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
              fetchStatus: async () => (sessionId ? (await getDialer(sessionId)).session.status : 'stopped'),
              rejoin: () => {
                const joining = joinLegRef.current(sessionId ?? null);
                gen = dialerRunRef.current;
                return joining;
              },
              stop: async () => { if (sessionId) await dialerControl(sessionId, 'stop'); },
            }, recentRejoins(legRejoinedAtRef.current, Date.now())).then((outcome) => {
              if (outcome === 'rejoined') legRejoinedAtRef.current = [...legRejoinedAtRef.current, Date.now()];
              // A Stop or a newer run got there first: its state is not ours to touch
              // (dropping here would bump the generation under a join in flight).
              if (outcome === 'superseded' || !isCurrent()) return;
              // `stop-failed`: the run may still be live. Keep the nav locked on the
              // Power Dial tab, where the Stop button is.
              if (outcome === 'run-over' || outcome === 'stopped') dropConferenceLeg();
              else if (outcome === 'stop-failed') setDialerLive(true); // the failed rejoin unlocked it
              const toast = legRecoveryToast(outcome);
              if (toast) setToast(toast);
            });
          };
          // Decision 9: a callback is waiting on the banner. Re-joining would
          // call device.connect(), which silently ignore()s it — hand it to the
          // ring screen instead, and recover only if that could not be done.
          if (callbackWaitingRef.current) {
            void handOffCallbackAfterDrop(sessionId ?? null).then((handedOff) => { if (!handedOff) recover(); });
            return;
          }
          recover();
        },
```

(l) Replace the end of `joinLeg`:

```ts
  }, [ensureDevice, dropConferenceLeg]);
```

with:

```ts
  }, [ensureDevice, dropConferenceLeg, handOffCallbackAfterDrop]);
```

(m) In the softphone-coordinator effect, replace:

```ts
      !!connectionRef.current ||
      !!dialerConnRef.current;
```

with:

```ts
      !!connectionRef.current ||
      !!dialerConnRef.current ||
      // A callback on the banner is ringing on this Device, and a run parked for
      // a callback is coming back to it.
      !!callbackWaitingRef.current ||
      !!parkedRunIdRef.current;
```

and replace:

```ts
        incomingRef.current ||
        dialerConnRef.current
      ) {
```

with:

```ts
        incomingRef.current ||
        dialerConnRef.current ||
        callbackWaitingRef.current ||
        parkedRunIdRef.current
      ) {
```

(n) Replace both occurrences (in `reset` and in `acceptIncoming`'s `backToIdle`) of:

```ts
pendingTeardownRef.current && !dialerConnRef.current)
```

with:

```ts
pendingTeardownRef.current && !dialerConnRef.current && !parkedRunIdRef.current)
```

(Use a replace-all edit; there are exactly two.)

(o) Replace the head of `acceptIncoming`:

```ts
  const acceptIncoming = useCallback(() => {
    const call = incoming;
    // Don't answer if an outbound dial just claimed the line.
    if (!call || placingRef.current) return;
```

with:

```ts
  const acceptCall = useCallback((call: TwilioIncomingCall | null) => {
    // Don't answer if an outbound dial just claimed the line.
    if (!call || placingRef.current) return;
    // Never over a live dialer leg: accept() would make the SDK disconnect it
    // (beforeAccept), and the leg's recovery would then stop the whole run. A
    // callback that reached the ring screen before the leg joined goes to the
    // run's banner instead, whose Pause & answer leaves the room first.
    if (dialerConnRef.current) {
      setIncoming((c) => (c === call ? null : c));
      if (callbackWaitingRef.current) { try { call.reject(); } catch { /* already gone */ } }
      else waitOnCallback(call);
      return;
    }
```

and replace its end:

```ts
  }, [incoming, teardownDevice]);
```

with:

```ts
  }, [teardownDevice, waitOnCallback]);
  const acceptIncoming = useCallback(() => acceptCall(incoming), [acceptCall, incoming]);
```

(p) After `declineIncoming` (after its `}, [incoming]);`), add:

```ts
  // Pause & answer (spec "What the rep sees", decisions 4-5), in the order
  // callback-waiting.ts runPauseAndAnswer pins: the server pauses the run FIRST
  // (cancelling a dial still ringing); only then does the rep leave the room;
  // only then is the callback answered through the normal inbound path
  // (screen-pop, recording, caller ID).
  const pauseAndAnswer = useCallback(async (): Promise<void> => {
    const waiting = callbackWaitingRef.current;
    const sessionId = legSessionIdRef.current;
    if (!waiting || !sessionId || takingCallbackRef.current) return;
    takingCallbackRef.current = true;
    setTakingCallback(true);
    try {
      await runPauseAndAnswer({
        takeCallback: () => takeDialerCallback(sessionId),
        stillRinging: () => callbackWaitingRef.current?.call === waiting.call && waiting.call.status?.() !== 'closed',
        leaveRoom: () => leaveRoomForCallback(sessionId),
        clear: () => { if (callbackWaitingRef.current?.call === waiting.call) setWaiting(null); },
        reject: () => rejectWaitingCallback(waiting),
        accept: () => acceptCall(waiting.call),
        toast: setToast,
        missedToast: () => missedCallbackToast(waiting.callerLabel, forwardE164Ref.current),
      });
    } finally {
      takingCallbackRef.current = false;
      setTakingCallback(false);
    }
  }, [acceptCall, leaveRoomForCallback, rejectWaitingCallback, setWaiting]);

  // Ignore: the callback forwards or goes to voicemail, exactly as today.
  const ignoreCallback = useCallback((): void => {
    const waiting = callbackWaitingRef.current;
    if (!waiting || takingCallbackRef.current) return;
    rejectWaitingCallback(waiting);
  }, [rejectWaitingCallback]);

  // DialerPanel hands every poll here (the lifted run snapshot, decision 3). A
  // callback already on the banner when the prospect answers — the snapshot it
  // was judged by can be up to two seconds old — is rejected now, with the
  // toast: the rep is talking, and Pause & answer would only 409.
  const handleRunSnapshot = useCallback((snapshot: RunSnapshot): void => {
    runSnapshotRef.current = snapshot;
    const waiting = callbackWaitingRef.current;
    if (!waiting || takingCallbackRef.current) return;
    if (snapshot.sessionId !== legSessionIdRef.current || !isTalking(snapshot)) return;
    rejectWaitingCallback(waiting, missedCallbackToast(waiting.callerLabel, forwardE164Ref.current));
  }, [rejectWaitingCallback]);

  // While a run is parked for a callback, the Power Dial panel — its usual
  // poller — is off screen, and the reaper stops a paused run nobody has
  // polled for ten minutes (decision 7). Beat once a minute until the run is
  // un-parked (Resume re-joined, Stop, run over) or the app unmounts.
  useEffect(() => {
    if (!parkedRunId) return undefined;
    return startParkedHeartbeat(parkedRunId, {
      poll: (id) => getDialer(id),
      onRunOver: () => dropConferenceLeg(),
      onUnreachable: () => setToast({ text: HEARTBEAT_UNREACHABLE_TEXT, type: 'error' }),
    });
  }, [parkedRunId, dropConferenceLeg]);
```

(q) In the `<DialerPanel ... />` JSX, replace:

```tsx
      lineAudio={lineAudio}
    />
```

with:

```tsx
      lineAudio={lineAudio}
      onRunSnapshot={handleRunSnapshot}
    />
```

`callbackWaiting`, `takingCallback`, `pauseAndAnswer` and `ignoreCallback` are wired into the banner in Task 3.

- [ ] **Step 16: Run to verify they pass**

Run: `cd apps/cti-web && npx vitest run src/App.callback-waiting.test.tsx src/App.test.tsx src/App.dialer-leg.test.tsx`
Expected: PASS for every test in all three files.

- [ ] **Step 17: Full web suite and typecheck**

Run: `cd apps/cti-web && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: every test file passes; `tsc` prints nothing.

- [ ] **Step 18: Commit**

```bash
git add apps/cti-web/src/callback-waiting.ts apps/cti-web/src/callback-waiting.test.ts apps/cti-web/src/parked-heartbeat.ts apps/cti-web/src/parked-heartbeat.test.ts apps/cti-web/src/dialer-api.ts apps/cti-web/src/dialer-api.test.ts apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.callback.test.tsx apps/cti-web/src/App.tsx apps/cti-web/src/App.callback-waiting.test.tsx apps/cti-web/src/App.test.tsx
git commit -F - <<'EOF'
feat(web): callbacks during a power-dial run — route, pause & answer, heartbeat

The Device takes calls while busy (allowIncomingWhileBusy at
construction). During a run a callback is rejected with a toast while
the rep talks, else waits for the banner; a later poll that shows
talking rejects it. Pause & answer: take-callback, clear the ref,
disconnect, accept. A leg drop while a callback waits parks the run
and rings normally instead of recovering. A parked run heartbeats
every 60 s. DialerPanel lifts its poll to App.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Web UI: the banner and chime, Resume = join then resume, one screen-pop across remounts

**Files:**
- Create: `apps/cti-web/src/callback-chime.ts`, `apps/cti-web/src/callback-chime.test.ts`
- Create: `apps/cti-web/src/components/CallbackBanner.tsx`, `apps/cti-web/src/components/CallbackBanner.test.tsx`
- Modify: `apps/cti-web/src/dialer-leg.ts` (append), `apps/cti-web/src/dialer-leg.test.ts`
- Modify: `apps/cti-web/src/components/DialerPanel.tsx`, `apps/cti-web/src/styles.css`, `apps/cti-web/src/App.tsx`
- Test: `apps/cti-web/src/components/DialerPanel.callback.test.tsx` (append), `apps/cti-web/src/App.callback-waiting.test.tsx` (append)

**Interfaces:**
- Consumes (Task 2): App's `callbackWaiting`, `takingCallback`, `pauseAndAnswer()`, `ignoreCallback()`, `parkedRunIdRef`, `setParked`, `legSessionIdRef`, `joinLeg`, `handleRunSnapshot`; `WaitingCallback`; the `onRunSnapshot` prop. Consumes (Task 1): the `/voice` `<Reject/>` for a refused named join.
- Produces:
  - `apps/cti-web/src/dialer-leg.ts`: `export const LEG_ACCEPT_TIMEOUT_MS = 10_000`; `export const LEG_REFUSED_MESSAGE`; `export function legAccepted(connection: unknown, timeoutMs?: number): Promise<void>`.
  - `apps/cti-web/src/callback-chime.ts`: `export const CHIME_BEEPS = 2`; `export const CHIME_GAP_MS = 450`; `export interface ChimeDeps`; `export function browserChimeDeps(): ChimeDeps`; `export async function playCallbackChime(deps?: ChimeDeps): Promise<void>`.
  - `apps/cti-web/src/components/CallbackBanner.tsx`: `export interface CallbackBannerProps { callerLabel: string; recordType?: string; busy: boolean; onAnswer: () => void; onIgnore: () => void }`; `export function CallbackBanner(props: CallbackBannerProps): JSX.Element`.
  - `apps/cti-web/src/components/DialerPanel.tsx`:
    - Types and functions: `export type ControlStep = DialerControlAction | 'join'`; `export function withRejoin(actions: DialerControlAction[], legDown: boolean): ControlStep[]`; `export interface PopLedger { sessionId: string | null; itemId: string | null }`; `export function shouldPopItem(ledger: PopLedger, sessionId: string, item: DialerCurrentItem | null): boolean`.
    - `runSequence` and `runControlsSequence` become generic in their step type.
    - Props: `callback?: (CallbackBannerProps & { id: string }) | null`, `needsRejoin?: () => boolean`, `onRejoin?: () => Promise<boolean>`, `popLedger?: MutableRefObject<PopLedger>`.

#### 3a. `legAccepted`

- [ ] **Step 1: Write the failing tests.** In `apps/cti-web/src/dialer-leg.test.ts`, change the import block to:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  dialerJoinParams,
  LEG_ACCEPT_TIMEOUT_MS,
  LEG_RECOVERY_DELAY_MS,
  LEG_RECOVERY_WINDOW_MS,
  LEG_REFUSED_MESSAGE,
  legAccepted,
  legRecoveryToast,
  MAX_LEG_RECOVERIES,
  recentRejoins,
  recoverDroppedLeg,
  STOP_RETRY_DELAYS_MS,
  watchDialerLeg,
  type LegRecoveryDeps,
} from './dialer-leg';
```

and append:

```ts
describe('legAccepted — Resume waits for Twilio to ANSWER the re-joined leg before the run dials', () => {
  class Conn {
    private h = new Map<string, Array<() => void>>();
    on(e: string, cb: () => void): void { this.h.set(e, [...(this.h.get(e) ?? []), cb]); }
    emit(e: string): void { for (const cb of this.h.get(e) ?? []) cb(); }
  }

  it('resolves on accept', async () => {
    const c = new Conn();
    const joined = legAccepted(c);
    c.emit('accept');
    await expect(joined).resolves.toBeUndefined();
  });

  it.each(['disconnect', 'error', 'cancel', 'reject'])("rejects when the leg ends first (%s) — the /voice guard's <Reject/> never answers", async (event) => {
    const c = new Conn();
    const joined = legAccepted(c);
    c.emit(event);
    await expect(joined).rejects.toThrow(LEG_REFUSED_MESSAGE);
  });

  it('settles once: an accept after a refusal changes nothing', async () => {
    const c = new Conn();
    const joined = legAccepted(c);
    c.emit('disconnect');
    c.emit('accept');
    await expect(joined).rejects.toThrow(LEG_REFUSED_MESSAGE);
  });

  it('rejects when nothing happens in time (default ten seconds)', async () => {
    expect(LEG_ACCEPT_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    try {
      const joined = legAccepted(new Conn(), 1000);
      const settled = expect(joined).rejects.toThrow(LEG_REFUSED_MESSAGE);
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connection with no events cannot be confirmed: rejects', async () => {
    await expect(legAccepted({})).rejects.toThrow(LEG_REFUSED_MESSAGE);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/dialer-leg.test.ts`
Expected: FAIL, with `legAccepted is not a function`.

- [ ] **Step 3: Implement.** Append to `apps/cti-web/src/dialer-leg.ts`:

```ts
/** How long a re-join may take to be answered before it counts as refused. */
export const LEG_ACCEPT_TIMEOUT_MS = 10_000;
export const LEG_REFUSED_MESSAGE = "Couldn't rejoin the run — if another power-dial run of yours is live, stop it first.";

/**
 * Resolves once Twilio has ANSWERED this leg (`accept`) — the room is really
 * joined. Rejects if the leg ends first (`disconnect`/`error`/`cancel`/
 * `reject`: the API's /voice guard answers a stale run's join with <Reject/>,
 * which never answers) or nothing happens within `timeoutMs`. Resume after a
 * callback waits on this before it POSTs resume (spec 2026-09-26 decision 6):
 * the server must not start dialing a paused run until its rep is back in the
 * room.
 */
export function legAccepted(connection: unknown, timeoutMs: number = LEG_ACCEPT_TIMEOUT_MS): Promise<void> {
  const on = (connection as { on?: (event: string, cb: () => void) => void } | null)?.on;
  if (typeof on !== 'function') return Promise.reject(new Error(LEG_REFUSED_MESSAGE));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (answered) resolve();
      else reject(new Error(LEG_REFUSED_MESSAGE));
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    on.call(connection, 'accept', () => settle(true));
    for (const event of ['disconnect', 'error', 'cancel', 'reject']) on.call(connection, event, () => settle(false));
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/cti-web && npx vitest run src/dialer-leg.test.ts`
Expected: PASS for every test in the file.

#### 3b. The chime and the banner

- [ ] **Step 5: Write the failing tests.** Create `apps/cti-web/src/callback-chime.test.ts`:

```ts
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserChimeDeps, CHIME_BEEPS, CHIME_GAP_MS, playCallbackChime } from './callback-chime';
import { testToneDataUri } from './audio-device-port';

const el = () => ({ src: '', play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) });

afterEach(() => { localStorage.clear(); });

describe('playCallbackChime — the SDK plays no ringtone while the rep is on the run leg, so this is the only sound', () => {
  it('beeps twice on the speaker chosen in Settings, a short gap apart', async () => {
    expect(CHIME_BEEPS).toBe(2);
    const els = [el(), el()];
    let i = 0;
    const wait = vi.fn(async () => {});
    await playCallbackChime({ createAudioElement: () => els[i++]!, outputDeviceId: () => 'spk-jabra', wait });
    for (const e of els) {
      expect(e.src).toBe(testToneDataUri());
      expect(e.setSinkId).toHaveBeenCalledWith('spk-jabra');
      expect(e.play).toHaveBeenCalledTimes(1);
    }
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(CHIME_GAP_MS);
  });

  it('"System default" plays on the browser default output — no setSinkId', async () => {
    const e = el();
    await playCallbackChime({ createAudioElement: () => e, outputDeviceId: () => 'default', wait: async () => {} });
    expect(e.setSinkId).not.toHaveBeenCalled();
    expect(e.play).toHaveBeenCalledTimes(2);
  });

  it('a play() the browser refuses rejects, so the caller can log it', async () => {
    const e = { src: '', play: vi.fn(async () => { throw new Error('NotAllowedError'); }) };
    await expect(playCallbackChime({ createAudioElement: () => e, outputDeviceId: () => 'default', wait: async () => {} })).rejects.toThrow('NotAllowedError');
  });

  it('the browser deps read the speaker saved in Settings, else the default', () => {
    expect(browserChimeDeps().outputDeviceId()).toBe('default');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    expect(browserChimeDeps().outputDeviceId()).toBe('spk-jabra');
  });
});
```

Create `apps/cti-web/src/components/CallbackBanner.test.tsx`:

```tsx
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallbackBanner } from './CallbackBanner';
import * as chime from '../callback-chime';

beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CallbackBanner', () => {
  it('names the caller and the record type', () => {
    render(<CallbackBanner callerLabel="Jane Doe" recordType="Lead" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(screen.getByText('Callback: Jane Doe · Lead')).toBeTruthy();
  });

  it('with no record type, just the caller', () => {
    render(<CallbackBanner callerLabel="+1 (619) 555-1234" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(screen.getByText('Callback: +1 (619) 555-1234')).toBeTruthy();
  });

  it('Pause & answer and Ignore call their handlers', () => {
    const onAnswer = vi.fn();
    const onIgnore = vi.fn();
    render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={onAnswer} onIgnore={onIgnore} />);
    fireEvent.click(screen.getByText('Pause & answer'));
    fireEvent.click(screen.getByText('Ignore'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  it('while the pause is in flight both buttons are disabled, and Answer says so', () => {
    render(<CallbackBanner callerLabel="Jane Doe" busy onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect((screen.getByText('Pausing…') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Ignore') as HTMLButtonElement).disabled).toBe(true);
  });

  it('chimes once when it appears — not again on a re-render', () => {
    const { rerender } = render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    rerender(<CallbackBanner callerLabel="Jane Doe" busy onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(1);
  });

  it('a chime the browser refuses is logged, not thrown — the banner is the signal', async () => {
    vi.mocked(chime.playCallbackChime).mockRejectedValue(new Error('NotAllowedError'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[callback] chime did not play', expect.any(Error)));
    expect(screen.getByText('Callback: Jane Doe')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/callback-chime.test.ts src/components/CallbackBanner.test.tsx`
Expected: FAIL, with `Failed to resolve import "./callback-chime"` and `"./CallbackBanner"`.

- [ ] **Step 7: Implement.** Create `apps/cti-web/src/callback-chime.ts`:

```ts
/**
 * The callback chime (spec 2026-09-26): the Voice SDK plays no ringtone for a
 * call that arrives while another is up (device.ts `_onSignalingInvite` plays
 * the incoming sound only when it was not busy), so a callback during a run
 * would ring in silence. Two short beeps of the Settings test tone
 * (audio-device-port.ts `playTestTone` — a generated WAV, no network) on the
 * speaker chosen in Settings.
 */
import { playTestTone, type TestToneElement } from './audio-device-port';
import { loadAudioPrefs, SYSTEM_DEFAULT } from './audio-devices';

export const CHIME_BEEPS = 2;
export const CHIME_GAP_MS = 450;

export interface ChimeDeps {
  createAudioElement: () => TestToneElement;
  /** The speaker chosen in Settings, or 'default'. */
  outputDeviceId: () => string;
  wait: (ms: number) => Promise<void>;
}

export function browserChimeDeps(): ChimeDeps {
  return {
    createAudioElement: () => new Audio(),
    outputDeviceId: () => loadAudioPrefs().output ?? SYSTEM_DEFAULT,
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

/** Rejects when the browser refuses to play (autoplay policy, a speaker that is gone). */
export async function playCallbackChime(deps: ChimeDeps = browserChimeDeps()): Promise<void> {
  const deviceId = deps.outputDeviceId();
  for (let i = 0; i < CHIME_BEEPS; i++) {
    if (i > 0) await deps.wait(CHIME_GAP_MS);
    await playTestTone(deviceId, deps.createAudioElement());
  }
}
```

Create `apps/cti-web/src/components/CallbackBanner.tsx`:

```tsx
/**
 * A callback ringing during a power-dial run while the rep is not talking to a
 * prospect (spec docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 * Sits above the current-record card; the rep has the ring window (~25 s) to
 * choose. Pause & answer parks the run and answers; Ignore lets the callback
 * forward or go to voicemail as it always did. Chimes once when it appears —
 * the SDK plays no ringtone for a call that arrives while another is up.
 */
import { useEffect, useRef } from 'react';
import { playCallbackChime } from '../callback-chime';

export interface CallbackBannerProps {
  /** The matched Salesforce name, else the formatted number. */
  callerLabel: string;
  recordType?: string;
  /** Pause & answer is in flight. */
  busy: boolean;
  onAnswer: () => void;
  onIgnore: () => void;
}

export function CallbackBanner({ callerLabel, recordType, busy, onAnswer, onIgnore }: CallbackBannerProps): JSX.Element {
  // Once per banner: a re-render (busy flipping) must not chime again, nor
  // React's development double-mount.
  const chimed = useRef(false);
  useEffect(() => {
    if (chimed.current) return;
    chimed.current = true;
    playCallbackChime().catch((err: unknown) => {
      // Not actionable for the rep, and the banner itself is the signal.
      console.warn('[callback] chime did not play', err);
    });
  }, []);
  return (
    <div className="section dp-callback" role="alert">
      <div className="dp-callback-text">{`Callback: ${callerLabel}${recordType ? ` · ${recordType}` : ''}`}</div>
      <div className="row dp-callback-actions">
        <button className="btn primary" disabled={busy} onClick={onAnswer}>{busy ? 'Pausing…' : 'Pause & answer'}</button>
        <button className="btn" disabled={busy} onClick={onIgnore}>Ignore</button>
      </div>
    </div>
  );
}
```

Append to `apps/cti-web/src/styles.css`, after the `.dp-waiting { ... }` rule:

```css
/* Power dialer: a callback ringing during the run (CallbackBanner) — green,
   the house colour for "a call". */
.dp-callback {
  border: 1px solid color-mix(in srgb, var(--good) 45%, transparent);
  background: color-mix(in srgb, var(--good) 10%, transparent);
}
.dp-callback-text { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.dp-callback-actions { gap: 8px; margin-top: 8px; }
.dp-callback-actions .btn { flex: 1; padding: 9px 6px; font-size: 12px; }
```

- [ ] **Step 8: Run to verify they pass**

Run: `cd apps/cti-web && npx vitest run src/callback-chime.test.ts src/components/CallbackBanner.test.tsx`
Expected: PASS, 10 tests.

#### 3c. DialerPanel: the banner, Resume re-joins first, the pop ledger

- [ ] **Step 9: Write the failing tests.** In `apps/cti-web/src/components/DialerPanel.callback.test.tsx`, replace the import block with:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialerPanel, shouldPopItem, withRejoin, type DialerPanelProps, type PopLedger } from './DialerPanel';
import * as dialerApi from '../dialer-api';
import * as chime from '../callback-chime';
import type { DialerControlAction, DialerCurrentItem, DialerSession, DialerSessionView } from '../dialer-api';
```

and append:

```tsx
describe('DialerPanel — the callback banner (Task 3)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });
  const cb = (o: Record<string, unknown> = {}) => ({
    id: 'CA1', callerLabel: 'Jane Doe', recordType: 'Lead', busy: false, onAnswer: vi.fn(), onIgnore: vi.fn(), ...o,
  });

  it('sits above the current-record card', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const { container } = mount({ callback: cb() });
    await screen.findByText('Callback: Jane Doe · Lead');
    const banner = container.querySelector('.dp-callback')!;
    const card = container.querySelector('.dp-current')!;
    expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows between dials too, when there is no current record', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: null }));
    mount({ callback: cb() });
    expect(await screen.findByText('Callback: Jane Doe · Lead')).toBeTruthy();
  });

  it('wires Pause & answer and Ignore', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const c = cb();
    mount({ callback: c });
    fireEvent.click(await screen.findByText('Pause & answer'));
    fireEvent.click(screen.getByText('Ignore'));
    expect(c.onAnswer).toHaveBeenCalledTimes(1);
    expect(c.onIgnore).toHaveBeenCalledTimes(1);
  });

  it('is not shown once the run is over', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'done', item: null }));
    mount({ callback: cb() });
    await screen.findByText('Run complete');
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
  });
});

describe('withRejoin — Resume re-joins the room first when this tab has no leg (decision 6)', () => {
  it('puts join in FRONT of any request that resumes, when the leg is down', () => {
    expect(withRejoin(['resume'], true)).toEqual(['join', 'resume']);
    expect(withRejoin(['next', 'resume'], true)).toEqual(['join', 'next', 'resume']);
    expect(withRejoin(['redial', 'resume'], true)).toEqual(['join', 'redial', 'resume']);
  });
  it('leaves everything else alone', () => {
    expect(withRejoin(['resume'], false)).toEqual(['resume']);
    expect(withRejoin(['pause'], true)).toEqual(['pause']);
    expect(withRejoin(['skip'], true)).toEqual(['skip']);
    expect(withRejoin(['stop'], true)).toEqual(['stop']);
  });
});

describe('DialerPanel — Resume after a callback (Task 3)', () => {
  function recordControls(order: string[]): void {
    vi.spyOn(dialerApi, 'dialerControl').mockImplementation(async (_id: string, action: DialerControlAction) => {
      order.push(action);
      return { ok: true };
    });
  }

  it('with no leg: joins the room first, and only then POSTs resume', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { order.push('join'); return true; } });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['join', 'resume']));
  });

  it('a join a Stop superseded (false) sends nothing', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => false);
    mount({ needsRejoin: () => true, onRejoin });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(onRejoin).toHaveBeenCalled());
    await new Promise((r) => { setTimeout(r, 20); });
    expect(order).toEqual([]);
  });

  it('a refused join says why and sends nothing', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { throw new Error("Couldn't rejoin the run — if another power-dial run of yours is live, stop it first."); } });
    fireEvent.click(await screen.findByText('Resume'));
    expect(await screen.findByText("Couldn't rejoin the run — if another power-dial run of yours is live, stop it first.")).toBeTruthy();
    expect(order).toEqual([]);
  });

  it('with a live leg: Resume is the plain resume it always was', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: null }));
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => true);
    mount({ needsRejoin: () => false, onRejoin });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['resume']));
    expect(onRejoin).not.toHaveBeenCalled();
  });

  it('a hung-up prospect card on a paused run: Resume re-joins, then next, then resume', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ sessionStatus: 'paused', item: { status: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' } }));
    const order: string[] = [];
    recordControls(order);
    mount({ needsRejoin: () => true, onRejoin: async () => { order.push('join'); return true; } });
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(order).toEqual(['join', 'next', 'resume']));
  });

  it('Pause never re-joins', async () => {
    vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view());
    const order: string[] = [];
    recordControls(order);
    const onRejoin = vi.fn(async () => true);
    mount({ needsRejoin: () => true, onRejoin });
    fireEvent.click(await screen.findByText('Pause'));
    await waitFor(() => expect(order).toEqual(['pause']));
    expect(onRejoin).not.toHaveBeenCalled();
  });
});

describe('DialerPanel — one screen-pop per connected record, across remounts (decision 8)', () => {
  it('shouldPopItem: a connected record not yet popped in THIS run', () => {
    const connected = { id: 'i1', recordId: '00Q1', objectType: 'Lead', status: 'connected', toNumber: null };
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', connected)).toBe(true);
    expect(shouldPopItem({ sessionId: 'sess1', itemId: 'i1' }, 'sess1', connected)).toBe(false);
    expect(shouldPopItem({ sessionId: 'sess0', itemId: 'i1' }, 'sess1', connected)).toBe(true);
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', { ...connected, status: 'dialing' })).toBe(false);
    expect(shouldPopItem({ sessionId: null, itemId: null }, 'sess1', null)).toBe(false);
  });

  it('an App-owned ledger stops a remounted panel popping the same record again', async () => {
    const getDialer = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected' } }));
    const ledger = { current: { sessionId: null, itemId: null } as PopLedger };
    const onScreenPop = vi.fn();
    const first = mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(onScreenPop).toHaveBeenCalledTimes(1));
    first.unmount();
    const before = getDialer.mock.calls.length;
    mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(getDialer.mock.calls.length).toBeGreaterThan(before));
    await new Promise((r) => { setTimeout(r, 20); });
    expect(onScreenPop).toHaveBeenCalledTimes(1);
  });

  it('a new record in the same run still pops', async () => {
    const getDialer = vi.spyOn(dialerApi, 'getDialer').mockResolvedValue(view({ item: { status: 'connected' } }));
    const ledger = { current: { sessionId: 'sess1', itemId: 'i0' } as PopLedger };
    const onScreenPop = vi.fn();
    mount({ onScreenPop, popLedger: ledger });
    await waitFor(() => expect(onScreenPop).toHaveBeenCalledWith('00Q1'));
    expect(ledger.current).toEqual({ sessionId: 'sess1', itemId: 'i1' });
    expect(getDialer).toHaveBeenCalled();
  });
});
```

- [ ] **Step 10: Run to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.callback.test.tsx`
Expected: FAIL. `withRejoin` and `shouldPopItem` aren't exported, there is no banner, Resume sends `resume` without joining, and the remount pops twice. The three Task 2 tests still pass.

- [ ] **Step 11: Implement** in `apps/cti-web/src/components/DialerPanel.tsx`.

Change the React import to:

```ts
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
```

and add after `import { runSnapshotOf, type RunSnapshot } from '../callback-waiting';`:

```ts
import { CallbackBanner, type CallbackBannerProps } from './CallbackBanner';
```

Replace `runSequence` and `runControlsSequence` (their signatures only; the bodies stay):

```ts
export async function runSequence(
  actions: DialerControlAction[],
  run: (action: DialerControlAction) => Promise<boolean>,
): Promise<boolean> {
  for (const action of actions) {
    if (!(await run(action))) return false;
  }
  return true;
}
```

with:

```ts
export async function runSequence<S>(
  steps: readonly S[],
  run: (step: S) => Promise<boolean>,
): Promise<boolean> {
  for (const step of steps) {
    if (!(await run(step))) return false;
  }
  return true;
}
```

and:

```ts
export async function runControlsSequence(
  actions: DialerControlAction[],
  send: (action: DialerControlAction) => Promise<boolean>,
  setBusy: (busy: boolean) => void,
): Promise<boolean> {
  setBusy(true);
  try {
    return await runSequence(actions, send);
  } finally {
    setBusy(false);
  }
}
```

with:

```ts
export async function runControlsSequence<S>(
  steps: readonly S[],
  send: (step: S) => Promise<boolean>,
  setBusy: (busy: boolean) => void,
): Promise<boolean> {
  setBusy(true);
  try {
    return await runSequence(steps, send);
  } finally {
    setBusy(false);
  }
}
```

Add right after `runControlsSequence`:

```ts
/** A step of a control-set request: a server action, or getting this tab's leg
 *  back into the run's room first. */
export type ControlStep = DialerControlAction | 'join';

/**
 * Pure — Resume after a callback (spec 2026-09-26 decision 6). The rep left the
 * room to take the call, so any request that ends in `resume` gets a `join` in
 * FRONT when this tab has no live leg: "never join the rep-scoped conference
 * before start is accepted", extended — for a paused run, join first, then
 * POST resume, so the server never dials into an empty room. Joining before
 * anything else also means a refused join changes nothing on the server.
 */
export function withRejoin(actions: DialerControlAction[], legDown: boolean): ControlStep[] {
  return legDown && actions.includes('resume') ? ['join', ...actions] : actions;
}

/** Which connected item was last screen-popped, per run (decision 8). */
export interface PopLedger { sessionId: string | null; itemId: string | null }

/** Pure — pop a live human's record once per run: not again for the same item,
 *  even if the panel was unmounted in between (ring and call screens replace it). */
export function shouldPopItem(ledger: PopLedger, sessionId: string, item: DialerCurrentItem | null): boolean {
  return shouldScreenPop(item) && item !== null && !(ledger.sessionId === sessionId && ledger.itemId === item.id);
}
```

In `DialerPanelProps`, after the `onRunSnapshot` prop, add:

```ts
  /** A callback waiting on this run (App.tsx): the banner above the current
   *  record. Null or absent: no banner. `id` keys it — one chime per callback. */
  callback?: (CallbackBannerProps & { id: string }) | null;
  /** True when this tab holds no live dialer leg — Resume must re-join the
   *  room first (decision 6). Absent: never. */
  needsRejoin?: () => boolean;
  /** Re-join the run's room; true once Twilio answered the leg, false when a
   *  Stop superseded it; rejects when the join was refused. */
  onRejoin?: () => Promise<boolean>;
  /** App-owned record of the last screen-popped item, so a remount never pops
   *  the same record again (decision 8). Absent: the panel keeps its own. */
  popLedger?: MutableRefObject<PopLedger>;
```

Replace the destructure line (as left by Task 2) with:

```ts
  const {
    sessionId, onScreenPop, onStartFromListView, onPrepare, onJoin, onStop, onComplete, onDismiss, holdMusic, lineAudio,
    onRunSnapshot, callback, needsRejoin, onRejoin, popLedger: sharedPopLedger,
  } = props;
```

Replace:

```ts
  // Id of the last currentItem we screen-popped for — pop once per NEW
  // connected item, not on every ~2 s (1 s while a dial is ringing) poll.
  const lastPoppedIdRef = useRef<string | null>(null);
```

with:

```ts
  // Which connected item was last screen-popped, per run — pop once per NEW
  // connected item, not on every ~2 s (1 s while a dial is ringing) poll. App
  // owns it when it can (decision 8): the ring and call screens unmount this
  // panel, and a panel-local ref would pop the same record again on remount.
  const ownPopLedger = useRef<PopLedger>({ sessionId: null, itemId: null });
  const popLedger = sharedPopLedger ?? ownPopLedger;
```

In the polling effect, delete the line:

```ts
    lastPoppedIdRef.current = null;
```

(the ledger is keyed by run, so a new session never matches), and replace:

```ts
        const current = next.currentItem;
        if (shouldScreenPop(current) && current && lastPoppedIdRef.current !== current.id) {
          lastPoppedIdRef.current = current.id;
          onScreenPop(current.recordId);
        }
```

with:

```ts
        const current = next.currentItem;
        if (shouldPopItem(popLedger.current, sessionId, current) && current) {
          popLedger.current = { sessionId, itemId: current.id };
          onScreenPop(current.recordId);
        }
```

Replace `sendControl`:

```ts
  const sendControl = useCallback((action: DialerControlAction): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false);
    return dialerControl(sessionId, action)
      .then(() => { pollNowRef.current(); return true; })
      .catch((e: unknown) => {
        setControlError(controlErrorMessage(e, `Could not ${action} the run.`));
        return false;
      });
  }, [sessionId]);
```

with:

```ts
  const sendControl = useCallback((step: ControlStep): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false);
    if (step === 'join') {
      // Resume after a callback: back into the room BEFORE the server dials.
      if (!onRejoin) return Promise.resolve(false);
      return onRejoin().catch((e: unknown) => {
        setControlError(controlErrorMessage(e, "Couldn't rejoin the run."));
        return false;
      });
    }
    return dialerControl(sessionId, step)
      .then(() => { pollNowRef.current(); return true; })
      .catch((e: unknown) => {
        setControlError(controlErrorMessage(e, `Could not ${step} the run.`));
        return false;
      });
  }, [sessionId, onRejoin]);
```

Replace:

```ts
  const runControls = useCallback((actions: DialerControlAction[]): Promise<boolean> => {
    setControlError(null);
    setConflictSessionId(null);
    return runControlsSequence(actions, sendControl, setControlBusy);
  }, [sendControl]);
```

with:

```ts
  const runControls = useCallback((steps: ControlStep[]): Promise<boolean> => {
    setControlError(null);
    setConflictSessionId(null);
    return runControlsSequence(steps, sendControl, setControlBusy);
  }, [sendControl]);
```

After `  const hungUp = Boolean(view.currentItem?.prospectEndedAt);` add:

```ts
  // No leg in the room (the rep left it for a callback): Resume re-joins first.
  const legDown = (): boolean => needsRejoin?.() ?? false;
```

Replace:

```tsx
      {view.currentItem && <CurrentRecord item={view.currentItem} listTotal={view.listContext?.total ?? null} />}
```

with:

```tsx
      {callback && !isTerminal && (
        <CallbackBanner
          key={callback.id}
          callerLabel={callback.callerLabel}
          recordType={callback.recordType}
          busy={callback.busy}
          onAnswer={callback.onAnswer}
          onIgnore={callback.onIgnore}
        />
      )}

      {view.currentItem && <CurrentRecord item={view.currentItem} listTotal={view.listContext?.total ?? null} />}
```

Replace the controls:

```tsx
              onClick={() => runControl(pauseResumeAction(view.session.status))}
```

with:

```tsx
              onClick={() => runControls(withRejoin([pauseResumeAction(view.session.status)], legDown()))}
```

and:

```tsx
              onNext={() => runControls(actionsFor('next', view.session.status))}
              onRedial={() => runControls(actionsFor('redial', view.session.status))}
```

with:

```tsx
              onNext={() => runControls(withRejoin(actionsFor('next', view.session.status), legDown()))}
              onRedial={() => runControls(withRejoin(actionsFor('redial', view.session.status), legDown()))}
```

- [ ] **Step 12: Run to verify they pass**

Run: `cd apps/cti-web && npx vitest run src/components/DialerPanel.callback.test.tsx src/components/DialerPanel.test.tsx src/components/DialerPanel.poll.test.tsx`
Expected: PASS for every test in all three files. The pre-existing `runSequence` / `runControlsSequence` tests still pass with the generic signatures.

#### 3d. App: the banner, Resume = join then resume, the pop ledger

- [ ] **Step 13: Write the failing App tests.** In `apps/cti-web/src/App.callback-waiting.test.tsx`, add after `import * as heartbeat from './parked-heartbeat';`:

```ts
import * as chime from './callback-chime';
```

and append:

```tsx
describe('App — the banner, Pause & answer, and Resume (Task 3)', () => {
  beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });

  /** A run on screen (a dial ringing by default), with a callback on the banner. */
  async function callbackOnBanner(item: { status: string; prospectEndedAt: string | null } = { status: 'dialing', prospectEndedAt: null }): Promise<FakeCall> {
    state.currentItem = item;
    await startRun();
    await screen.findByText(item.prospectEndedAt ? 'They hung up' : /Dialing/);
    const call = callbackCall();
    ring(call);
    await screen.findByText('Callback: Jane Doe · Lead');
    return call;
  }

  /** Pause & answer, then the callback ends: the paused run is back on screen. */
  async function takeAndFinish(call: FakeCall): Promise<void> {
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    act(() => { call.emit('disconnect'); });
  }

  it('shows the banner above the current record, and chimes once', async () => {
    await callbackOnBanner();
    expect(screen.getByText('Pause & answer')).toBeTruthy();
    expect(screen.getByText('Ignore')).toBeTruthy();
    const banner = document.querySelector('.dp-callback')!;
    const card = document.querySelector('.dp-current')!;
    expect(banner.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(1);
  });

  it('Ignore rejects the callback (forward/voicemail as today) and leaves the run alone', async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Ignore'));
    expect(call.reject).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
    expect(state.controls).not.toContain('take-callback');
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('the caller hanging up first takes the banner down', async () => {
    const call = await callbackOnBanner();
    act(() => { call.emit('cancel'); });
    expect(screen.queryByText('Callback: Jane Doe · Lead')).toBeNull();
    expect(call.reject).not.toHaveBeenCalled();
  });

  it('Pause & answer: the server pauses FIRST, then the rep leaves the room, then the callback is answered — and the dropped leg is never recovered', async () => {
    const call = await callbackOnBanner();
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.accept).toHaveBeenCalledTimes(1));
    expect(state.events).toEqual(['take-callback', 'leg-disconnect', 'accept']);
    expect(opencti.screenPopRecord).toHaveBeenCalledWith('00QCALLBACK000001');
    expect(await screen.findByTitle('End call')).toBeTruthy();
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(1);
    expect(state.controls).not.toContain('stop');
    expect(document.querySelector('.nav')).toBeNull();
  }, 15_000);

  it('409 — a prospect answered in the race: the callback is rejected with the toast, and the rep stays in the room', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'connected';
    fireEvent.click(screen.getByText('Pause & answer'));
    await waitFor(() => expect(call.reject).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Missed callback from Jane Doe — you were on a call. It went to voicemail.')).toBeTruthy();
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('a pause that fails keeps the banner up (try again, or Ignore) and says why', async () => {
    const call = await callbackOnBanner();
    state.takeCallback = 'error';
    fireEvent.click(screen.getByText('Pause & answer'));
    expect(await screen.findByText("Couldn't pause the run to answer: database unavailable")).toBeTruthy();
    expect(screen.getByText('Callback: Jane Doe · Lead')).toBeTruthy();
    expect(call.accept).not.toHaveBeenCalled();
    expect(FakeDevice.connects[0]!.connection.disconnect).not.toHaveBeenCalled();
  });

  it('after the callback: back on the paused run; Resume joins the room, waits for Twilio to answer the leg, THEN resumes', async () => {
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects.length).toBe(2));
    expect(FakeDevice.connects[1]!.params).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
    await waitFor(() => expect(FakeDevice.connects[1]!.connection.hasListenerFor('accept')).toBe(true));
    expect(state.controls).not.toContain('resume');
    act(() => { FakeDevice.connects[1]!.connection.emit('accept'); });
    await waitFor(() => expect(state.controls).toContain('resume'));
  }, 15_000);

  it("a refused re-join (another run of the rep's owns the room) resumes nothing, says so, keeps the phone on Power Dial, and is not recovered", async () => {
    await takeAndFinish(await callbackOnBanner());
    fireEvent.click(await screen.findByText('Resume'));
    await waitFor(() => expect(FakeDevice.connects[1]?.connection.hasListenerFor('accept')).toBe(true));
    act(() => { FakeDevice.connects[1]!.connection.emit('disconnect'); });
    expect(await screen.findByText(/Couldn't rejoin the run/)).toBeTruthy();
    expect(state.controls).not.toContain('resume');
    expect(document.querySelector('.nav')).toBeNull();
    await new Promise((r) => { setTimeout(r, 2200); });
    expect(FakeDevice.connects.length).toBe(2);
  }, 15_000);

  it('the prospect card that popped before the callback does not pop again when the panel comes back', async () => {
    await takeAndFinish(await callbackOnBanner({ status: 'connected', prospectEndedAt: '2026-09-26T17:00:00.000Z' }));
    await screen.findByText('Redial');
    await new Promise((r) => { setTimeout(r, 2500); });
    expect(vi.mocked(opencti.screenPopRecord).mock.calls.map(([id]) => id)).toEqual(['00QPROSPECT000001', '00QCALLBACK000001']);
  }, 15_000);
});
```

- [ ] **Step 14: Run to verify they fail**

Run: `cd apps/cti-web && npx vitest run src/App.callback-waiting.test.tsx`
Expected: FAIL. App doesn't pass `callback` to DialerPanel yet, so no banner appears and every Task 3 test times out waiting for `Callback: Jane Doe · Lead`. The Task 2 tests still pass.

- [ ] **Step 15: Implement** in `apps/cti-web/src/App.tsx`.

Change the imports:

```ts
import { DialerPanel, processedCount } from './components/DialerPanel';
```

to:

```ts
import { DialerPanel, processedCount, type PopLedger } from './components/DialerPanel';
```

and:

```ts
import { dialerJoinParams, legRecoveryToast, recentRejoins, recoverDroppedLeg, watchDialerLeg } from './dialer-leg';
```

to:

```ts
import { dialerJoinParams, legAccepted, legRecoveryToast, recentRejoins, recoverDroppedLeg, watchDialerLeg } from './dialer-leg';
```

After `export const HANGUP_FALLBACK_MS = 1500;` add:

```ts
/** joinLeg options. `awaitAccept` (Resume after a callback): adopt the leg only
 *  once Twilio has answered it, so a refused join is never taken for a live
 *  leg — nor "recovered". */
interface JoinLegOptions { awaitAccept?: boolean }
```

After `  const runSnapshotRef = useRef<RunSnapshot | null>(null);` add:

```ts
  // The last screen-popped power-dial item, per run — owned here so the panel,
  // which the ring and call screens unmount, never pops it twice (decision 8).
  const popLedgerRef = useRef<PopLedger>({ sessionId: null, itemId: null });
```

Replace:

```ts
  const joinLegRef = useRef<(recoveringSessionId?: string | null) => Promise<boolean>>(async () => false);
  // `recoveringSessionId` is set (to the run's id) only when dialer-leg.ts is
  // bringing back a leg that dropped on its own; a fresh Start passes nothing.
  const joinLeg = useCallback(async (recoveringSessionId?: string | null): Promise<boolean> => {
```

with:

```ts
  const joinLegRef = useRef<(recoveringSessionId?: string | null, opts?: JoinLegOptions) => Promise<boolean>>(async () => false);
  // `recoveringSessionId` is set (to the run's id) when dialer-leg.ts is
  // bringing back a leg that dropped on its own, or when Resume re-joins a run
  // parked for a callback; a fresh Start passes nothing.
  const joinLeg = useCallback(async (recoveringSessionId?: string | null, opts: JoinLegOptions = {}): Promise<boolean> => {
```

Replace:

```ts
      if (dialerRunRef.current !== myRun) {
        try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
        return false;
      }
      dialerConnRef.current = connection;
      legSessionIdRef.current = sessionId ?? null;
```

with:

```ts
      if (dialerRunRef.current !== myRun) {
        try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
        return false;
      }
      if (opts.awaitAccept) {
        // Resume: the server may dial as soon as this resolves, so the leg must
        // really be in the room. A refusal (<Reject/> from the /voice guard) or
        // a timeout throws, and nothing adopts or watches this leg.
        try {
          await legAccepted(connection);
        } catch (e) {
          try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
          throw e;
        }
        if (dialerRunRef.current !== myRun) {
          try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
          return false;
        }
      }
      dialerConnRef.current = connection;
      legSessionIdRef.current = sessionId ?? null;
```

Replace:

```ts
  joinLegRef.current = joinLeg;
  const joinDialerConference = useCallback((): Promise<boolean> => joinLeg(), [joinLeg]);
```

with:

```ts
  joinLegRef.current = joinLeg;
  const joinDialerConference = useCallback((): Promise<boolean> => joinLeg(), [joinLeg]);

  // Resume after a callback (spec decision 6): this tab has no leg in the room,
  // so join it — naming the run, and waiting until Twilio has answered the leg —
  // before DialerPanel POSTs resume. A refused join rejects and nothing resumes;
  // the phone stays on the Power Dial tab, where Resume and Stop are.
  const rejoinRun = useCallback(async (): Promise<boolean> => {
    const sessionId = parkedRunIdRef.current ?? dialerSessionIdRef.current;
    if (!sessionId) return false;
    const phaseFree = phaseRef.current === 'idle' || phaseRef.current === 'preflight';
    if (!phaseFree || connectionRef.current || incomingRef.current) {
      throw new Error('Finish the current call before resuming the run.');
    }
    try {
      const joined = await joinLeg(sessionId, { awaitAccept: true });
      if (joined) setParked(null); // back in the room: the heartbeat stops
      return joined;
    } catch (e) {
      if (parkedRunIdRef.current) setDialerLive(true); // joinLeg's failure path unlocked the nav
      throw e;
    }
  }, [joinLeg, setParked]);
  // Read at click time: is this tab's leg out of the room?
  const legIsDown = useCallback((): boolean => !dialerConnRef.current, []);
```

In the `<DialerPanel ... />` JSX, replace:

```tsx
      onRunSnapshot={handleRunSnapshot}
    />
```

with:

```tsx
      onRunSnapshot={handleRunSnapshot}
      callback={callbackWaiting ? {
        id: callbackWaiting.id,
        callerLabel: callbackWaiting.callerLabel,
        recordType: callbackWaiting.recordType,
        busy: takingCallback,
        onAnswer: () => { void pauseAndAnswer(); },
        onIgnore: ignoreCallback,
      } : null}
      needsRejoin={legIsDown}
      onRejoin={rejoinRun}
      popLedger={popLedgerRef}
    />
```

- [ ] **Step 16: Run to verify they pass**

Run: `cd apps/cti-web && npx vitest run src/App.callback-waiting.test.tsx src/App.dialer-leg.test.tsx src/App.test.tsx`
Expected: PASS for every test in all three files.

- [ ] **Step 17: Full web suite and typecheck**

Run: `cd apps/cti-web && npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: every test file passes; `tsc` prints nothing.

- [ ] **Step 18: Commit**

```bash
git add apps/cti-web/src/dialer-leg.ts apps/cti-web/src/dialer-leg.test.ts apps/cti-web/src/callback-chime.ts apps/cti-web/src/callback-chime.test.ts apps/cti-web/src/components/CallbackBanner.tsx apps/cti-web/src/components/CallbackBanner.test.tsx apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/components/DialerPanel.callback.test.tsx apps/cti-web/src/styles.css apps/cti-web/src/App.tsx apps/cti-web/src/App.callback-waiting.test.tsx
git commit -F - <<'EOF'
feat(web): callback banner + chime; Resume re-joins first; one screen-pop across remounts

The banner sits above the current record with Pause & answer / Ignore
and a two-beep chime on the Settings speaker. With no leg in the room,
Resume joins, waits for Twilio to answer the leg, then POSTs resume; a
refused join resumes nothing. The last screen-popped item is owned by
App, so a remounted panel never pops it twice.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Docs: runbook and rep guide

**Files:**
- Modify: `docs/runbooks/dialer-cadence.md` (the "Skip outcomes" table; a new section before `## SQL`)
- Modify (outside the repo, not committed): `~/Documents/gg-guides-site/public/power-dial.html`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–3 (routes, strings, behaviour).
- Produces: operator and rep documentation. No code.

- [ ] **Step 1: The skip outcome.** In `docs/runbooks/dialer-cadence.md`, add this row to the "Skip outcomes" table, after the `in_progress_elsewhere` row:

```markdown
| `canceled` | counted in "N skipped" | The rep took a callback (Pause & answer) while this record was ringing. The call was hung up and the person requeued at the same ordinal with a 5-min floor. Not a dial for the follow-up rollover or the per-customer ceiling. The phone rang, so it still counts for the 3 h courtesy and the state-law cap. |
```

- [ ] **Step 2: The section.** Insert before `## SQL (read-only; use the \`$PUB\` pattern from the number-fleet runbook)`:

````markdown
## Callbacks during a run

Spec: `docs/superpowers/specs/2026-09-26-callback-waiting-design.md`. Until this change, a rep's softphone dropped every callback while they power dialed (Twilio child leg `busy`, 0 s). The Voice SDK now takes the call (`allowIncomingWhileBusy`), and the softphone decides what happens:

| The rep is… | What happens |
|---|---|
| talking to a prospect (current record connected, prospect still on the line) | Rejected at once, so it forwards or goes to voicemail as before. Toast: "Missed callback from … — you were on a call. It went to your cell / voicemail." |
| in a run but not talking (a dial ringing, between dials, paused, or the prospect hung up) | A green banner above the current record, "Callback: <name or number> · <type>", with **Pause & answer** and **Ignore**, plus a two-beep chime on the speaker chosen in Settings. The 25 s ring window applies. |
| not in a run | Today's ring screen, unchanged. |

**Pause & answer, in order:**
1. `POST /dialer/sessions/:id/take-callback`. This pauses the run first. A dial still ringing is settled `skipped`/`canceled` and its person requeued; the call is hung up after the commit.
2. The softphone leaves the run's room.
3. The callback is answered as a normal inbound call: screen-pop, recording, caller ID.

A `409 { reason: 'connected' }` means a prospect answered in the race: the callback is rejected with the toast, and the rep stays in the room.

**Afterwards** the run is paused. **Resume** first re-joins the room and waits for Twilio to answer the leg, then POSTs `resume`. While the rep is on the callback, the softphone GETs the run every 60 s so the 10-min reaper leaves it alone. If the leg drops on its own while a callback is on the banner, the softphone doesn't reconnect: it pauses the run the same way and lets the callback ring normally.

**Server guards added with it:**
- The `/voice` conference join answers `<Reject/>` when the run it names isn't live or another of the rep's runs is `active` (`dialer/join-guard.ts`).
- The `pending → dialing` claim re-checks that the run is `active`.
- A connect is a compare-and-swap on `dialing`: a person answering a call whose row was already settled is hung up, never bridged.

**The iPhone** shares the rep's Twilio identity, so the callback rings there too. Answering it on the iPhone takes the web banner down and leaves the run dialing.

**"A callback never rang me."** Look up the child leg: `Calls.json?ParentCallSid=<calls.provider_call_id>`.
- `busy`, 0 s: the softphone rejected it. The rep was talking (there was a toast), or pressed Ignore.
- `no-answer`, ~25 s: the banner was up and nobody chose.
- `completed`: answered.

A run's callback cancels and their requeued copies:
```sql
SELECT i.ordinal, i.record_id, i.status, i.outcome, i.retry_not_before, i.updated_at
  FROM dialer_queue_items i
 WHERE i.session_id = '<uuid>'
   AND i.ordinal IN (SELECT ordinal FROM dialer_queue_items
                      WHERE session_id = '<uuid>' AND status = 'skipped' AND outcome = 'canceled')
 ORDER BY i.ordinal, i.updated_at;
```

````

- [ ] **Step 3: Verify the runbook renders the new rows**

Run: `grep -n "Callbacks during a run\|take-callback\|counted in" docs/runbooks/dialer-cadence.md`
Expected: three or more matching lines: the section heading, the route, and the `canceled` table row.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/dialer-cadence.md
git commit -F - <<'EOF'
docs(runbooks): callbacks during a power-dial run

What the rep sees, the Pause & answer order and 409, Resume, the
heartbeat, the new server guards, the callback-cancel skip outcome, and
how to trace a callback that never rang.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 5: The rep guide (outside this repo).** In `~/Documents/gg-guides-site/public/power-dial.html`, insert immediately before the `<section class="ref wrap">` whose `<h2>` is `Good to know`:

```html
  <section class="ref wrap">
    <h2>When a customer calls you back mid-run</h2>
    <ul class="step-list" style="padding-left:0">
      <li><strong>Talking to someone?</strong> The callback is not put through. It goes to your cell (if you set a forward in Settings) or to voicemail, and a note says <strong>Missed callback from …</strong>.</li>
      <li><strong>Not talking?</strong> A green bar appears above the current record, <strong>Callback: name · type</strong>, with a short double beep. You have about 25 seconds to choose.</li>
      <li><span class="kbd primary">Pause &amp; answer</span> pauses the run and puts the callback through with their record popped. A call that was still ringing is hung up and tried again a few minutes later, and it does not count against that customer.</li>
      <li><span class="kbd">Ignore</span> sends the callback to your cell or voicemail, exactly as before. The run keeps going.</li>
      <li>When the callback is over you are back on the paused run. Tap <span class="kbd">Resume</span>: it reconnects you first, then starts dialing.</li>
      <li>The callback rings your iPhone too. If you answer it there, the run keeps dialing, so pause first.</li>
    </ul>
  </section>

```

This file isn't under git and nothing here commits it. **Shipping it is a user step:** the gHost `POST /apps/<id>/ship` in `~/Documents/gg-guides-site/README.md` publishes public content, so it needs the user's explicit go-ahead. Don't run it from this plan.

---

## Self-review (done while writing; kept for the executor)

- **Spec coverage:**
  - "What the rep sees":
    - Talking → reject + toast: Task 2 (routing, toast).
    - Not talking → banner + chime + 25 s window: Task 2 (routing) and Task 3 (banner, chime).
    - Ignore, and the caller hanging up first: Task 2 (handlers) and Task 3 (UI tests).
    - Pause & answer steps 1–5: Task 1 (`takeCallback`), Task 2 (`runPauseAndAnswer`, `leaveRoomForCallback`, `acceptCall`), Task 3 (Resume).
    - The caller hanging up during Pause & answer: Task 2 (`caller-gone`, and the accept-time cancel path unchanged).
  - Decisions:
    - 1 (Device flag): Task 2.
    - 2 (a manual call is unchanged): Task 2 (App.test.tsx pin).
    - 3 (talking rule, lifted snapshot): Tasks 1 and 2.
    - 4 (endpoint: pause first, cancel + requeue, 409, idempotent, owner-only): Task 1.
    - 5 (ref cleared before disconnect, no beforeAccept, nav locked, no teardown flush): Task 2 (plus the `acceptCall` choke point).
    - 6 (join then resume; the `/voice` guard): Tasks 1 and 3.
    - 7 (heartbeat): Task 2.
    - 8 (screen-pop ledger): Task 3.
    - 9 (recovery while a callback rings): Task 2.
    - 10 (iOS unchanged): no iOS task; the risk is documented in Task 4.
  - Spec Task 4 (docs): Task 4.
- **Placeholders:** none. Every code step shows the full code.
- **Type consistency:** these names match across tasks: `RunSnapshot`, `WaitingCallback`, `takeDialerCallback`, `setParked`, `legSessionIdRef`, `JoinLegOptions`, `ControlStep`, `PopLedger`, `LEG_REFUSED_MESSAGE`. `TakeCallbackResult` (Task 1) matches the route's 200 and 409 bodies, which match `takeCallbackRefusal` and the App test stubs (Tasks 2–3).
