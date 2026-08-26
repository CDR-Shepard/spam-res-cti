# Power Dialer Enablement + CTI Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make power dialing a per-user granted capability (default OFF for everyone), admin-managed from a new softphone Team panel, then swap all reps' Salesforce Call Center to the new CTI.

**Architecture:** One boolean on `users` (`power_dialer_enabled`, like `inbound_enabled`), carried by `resolveSession` so every route and `/auth/me` sees it for free. A `requirePowerDialer` guard 403s all five power-dial entry points in `routes/dialer.ts`. Admin CRUD lives in `routes/admin.ts` (`GET /admin/team`, `PATCH /admin/team/:userId`, org-scoped WHERE). The softphone hides the Power Dial tab via `navTabsFor` and gains an admin-only Team panel. The swap is a runbook + idempotent sf-CLI script setting `User.CallCenterId`.

**Tech Stack:** Fastify + Drizzle/Postgres + zod (services/cti-api), React 18 + vitest (apps/cti-web), sf CLI (swap script).

## Global Constraints

- Flag default `false` for ALL users; **nobody is seeded enabled**.
- Refusal shape everywhere: `403 { error: 'power_dialer_disabled' }`.
- Gated entry points (exactly these): `GET /dialer/salesforce/listviews`, `POST /dialer/sessions`, `POST /dialer/sessions/from-listview`, `POST /dialer/handoffs`, `GET /dialer/handoffs/pending`.
- NOT gated: `pause`/`resume`/`skip`/`stop`/`next` session management, `/telephony/twilio/dialer-*` webhooks, everything outside the power dialer.
- Admin routes 403 non-admins with the existing `{ error: 'Admin only' }` shape; the PATCH is org-scoped **in the WHERE clause** and its predicate is pinned with `renderPredicate` in tests.
- The flag is independent of admin: an admin without it does not see the Power Dial tab and cannot start runs.
- Migration is additive `IF NOT EXISTS`, numbered `0029`.
- `.claude/launch.json` is a pre-existing unstaged deletion — never stage, restore, or commit it.
- Gates at head of each task: `cd services/cti-api && npx tsc --noEmit && npm test` for API tasks; `cd apps/cti-web && npx tsc --noEmit && npm test && npm run build` for web tasks.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `services/cti-api/migrations/0029_power_dialer_enabled.sql` (create) | Additive column |
| `services/cti-api/src/db/schema.ts` (modify ~:196) | Drizzle column next to `inboundEnabled` |
| `services/cti-api/src/auth/session.ts` (modify :23-45) | `resolveSession` carries the flag |
| `services/cti-api/src/routes/dialer.ts` (modify) | `requirePowerDialer` + 5 gates |
| `services/cti-api/src/routes/dialer-handoffs.test.ts` (modify) | Gate tests (harness already registers all dialer routes) |
| `services/cti-api/src/routes/admin.ts` (modify) | `GET /admin/team`, `PATCH /admin/team/:userId` |
| `services/cti-api/src/routes/admin-team.test.ts` (create) | Team route tests + predicate pinning |
| `apps/cti-web/src/nav.ts` + `nav.test.ts` (modify) | Tab gating + `team` tab |
| `apps/cti-web/src/team-api.ts` (create) | Typed API calls |
| `apps/cti-web/src/components/TeamPanel.tsx` + `.test.tsx` (create) | Admin toggle UI |
| `apps/cti-web/src/App.tsx` (modify :37, :1229, :1238, panel switch ~:1188) | MeResponse + nav + render Team panel |
| `services/cti-api/scripts/swap-call-center.mjs` (create) | Call-center swap, DB-derived roster, rollback |
| `docs/runbooks/cti-swap.md` (create) | Swap + enablement runbook |

---

### Task 1: Flag in data + session + dialer gates

**Files:**
- Create: `services/cti-api/migrations/0029_power_dialer_enabled.sql`
- Modify: `services/cti-api/src/db/schema.ts` (users table, next to `inboundEnabled` at ~:196)
- Modify: `services/cti-api/src/auth/session.ts:23-45`
- Modify: `services/cti-api/src/routes/dialer.ts` (imports; the five entry points)
- Test: `services/cti-api/src/routes/dialer-handoffs.test.ts`

**Interfaces:**
- Consumes: existing `resolveSession(bearer)`, existing dialer route handlers.
- Produces: `resolveSession` return type gains `powerDialerEnabled: boolean` (Tasks 2–3 rely on this — `/auth/me` spreads `...session`, so the flag reaches the softphone with NO change to `auth.ts`). `schema.users.powerDialerEnabled` column (Task 2 relies on it).

- [ ] **Step 1: Write the failing gate tests**

In `services/cti-api/src/routes/dialer-handoffs.test.ts`:

1. Widen the hoisted session type (the `state` block at the top):

```ts
authedUser: null as {
  userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
} | null,
```

2. Widen `FakeUser` (used by the handoff POST's target lookup):

```ts
interface FakeUser {
  id: string;
  orgId: string;
  powerDialerEnabled?: boolean;
}
```

3. Every EXISTING test that sets `state.authedUser` gains `powerDialerEnabled: true` (they exercise post-gate behavior). Every existing `user:` fixture passed to `makeFakeDb` gains `powerDialerEnabled: true`.

4. New describe block (uses the file's existing `makeApp`/`makeFakeDb` helpers — read them first; they build a Fastify app with `registerDialerRoutes` and set `state.db`):

```ts
describe('power dialer gate (spec 2026-08-25)', () => {
  const disabled = {
    userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false, powerDialerEnabled: false,
  };

  it.each([
    ['GET', '/dialer/salesforce/listviews?object=Lead'],
    ['POST', '/dialer/sessions'],
    ['POST', '/dialer/sessions/from-listview'],
    ['GET', '/dialer/handoffs/pending'],
  ] as const)('%s %s → 403 power_dialer_disabled when the flag is off', async (method, url) => {
    state.authedUser = disabled;
    state.db = makeFakeDb();
    const app = await makeApp();
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
  });

  it('an enabled user passes the gate (listviews fails LATER, not with 403)', async () => {
    state.authedUser = { ...disabled, powerDialerEnabled: true };
    state.db = makeFakeDb();
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/dialer/salesforce/listviews?object=Lead' });
    expect(res.statusCode).not.toBe(403); // gate passed; 502 from unmocked SF is fine
  });

  it('session management is NOT gated: stop with the flag off is not a power_dialer 403', async () => {
    state.authedUser = disabled;
    state.db = makeFakeDb();
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/dialer/sessions/some-id/stop' });
    expect(res.json()).not.toEqual({ error: 'power_dialer_disabled' });
  });

  it('the SF handoff relay refuses a resolved target whose flag is off', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 's3cret';
    state.db = makeFakeDb({
      conn: { userId: 'u1', sfUserId: '005000000000001' },
      user: { id: 'u1', orgId: 'o1', powerDialerEnabled: false },
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 's3cret' },
      payload: { salesforceUserId: '005000000000001', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
  });

  it('the relay still accepts an UNRESOLVED target (no SF connection yet) — pickup is gated instead', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 's3cret';
    state.db = makeFakeDb({ conn: null, user: null });
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 's3cret' },
      payload: { salesforceUserId: '005000000000001', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    });
    expect(res.statusCode).toBe(200);
  });
});
```

Adapt payloads/urls to the file's existing conventions if they differ (read the existing handoff tests in the same file for the exact inject shapes — the handoff POST payload shape above must match `parseHandoffInput`'s).

- [ ] **Step 2: Run to verify failure**

Run: `cd services/cti-api && npx vitest run src/routes/dialer-handoffs.test.ts`
Expected: FAIL — TypeScript errors on `powerDialerEnabled` (schema/session don't have it yet) and/or 403s not produced.

- [ ] **Step 3: Migration**

Create `services/cti-api/migrations/0029_power_dialer_enabled.sql`:

```sql
-- Power dialing is a granted capability (spec 2026-08-25): default OFF for
-- every existing and future user; admins flip it per user from the softphone
-- Team panel. Gates live in routes/dialer.ts (requirePowerDialer).
ALTER TABLE users ADD COLUMN IF NOT EXISTS power_dialer_enabled boolean NOT NULL DEFAULT false;
```

- [ ] **Step 4: Schema + session**

In `services/cti-api/src/db/schema.ts`, next to `inboundEnabled` (~:196):

```ts
    powerDialerEnabled: boolean('power_dialer_enabled').default(false).notNull(),
```

In `services/cti-api/src/auth/session.ts`, extend the return type and value:

```ts
export async function resolveSession(bearer: string | undefined): Promise<{
  userId: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  powerDialerEnabled: boolean;
} | null> {
```

and the final return:

```ts
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    isAdmin: user.isAdmin,
    powerDialerEnabled: user.powerDialerEnabled,
  };
```

(`/auth/me` in `routes/auth.ts` spreads `...session`, so the flag flows to clients with no change there. Do NOT edit auth.ts.)

- [ ] **Step 5: Guard + call sites in `routes/dialer.ts`**

Add `FastifyReply` to the fastify type import, then near the top of the route registrations:

```ts
/** Power dialing is a granted capability (spec 2026-08-25): every ENTRY point
 *  refuses users without the flag. Session management (pause/skip/stop/next)
 *  stays ungated so a mid-run disable never strands an in-flight run. */
function requirePowerDialer(
  authed: { powerDialerEnabled: boolean },
  reply: FastifyReply,
): boolean {
  if (authed.powerDialerEnabled) return true;
  void reply.code(403).send({ error: 'power_dialer_disabled' });
  return false;
}
```

Immediately after the `if (!authed) return reply.code(401)…` line in each of these FOUR handlers — `GET /dialer/salesforce/listviews`, `POST /dialer/sessions`, `POST /dialer/sessions/from-listview`, `GET /dialer/handoffs/pending` — add:

```ts
    if (!requirePowerDialer(authed, reply)) return reply;
```

In `POST /dialer/handoffs` (secret-authed relay), right after the existing `const user = conn ? await db.query.users.findFirst(…) : undefined;` line:

```ts
    // Refuse a resolved target without the capability. An UNRESOLVED target
    // (rep not SF-connected yet) is allowed through: the pickup poll and
    // session creation are both gated, so nothing can start from it anyway.
    if (user && !user.powerDialerEnabled) {
      return reply.code(403).send({ error: 'power_dialer_disabled' });
    }
```

- [ ] **Step 6: Run the file, then the full gates**

Run: `npx vitest run src/routes/dialer-handoffs.test.ts` → PASS.
Run: `npx tsc --noEmit && npm test` → tsc clean; suite green. Any OTHER test that stubs `resolveSession`'s return will now have a type error — add `powerDialerEnabled: true` to those stubs (search: `rg -l "isAdmin: (true|false)" src --glob '*.test.ts'`).

- [ ] **Step 7: Commit**

```bash
git add services/cti-api/migrations/0029_power_dialer_enabled.sql services/cti-api/src/db/schema.ts services/cti-api/src/auth/session.ts services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/*.test.ts
git commit -m "feat(cti-api): power dialing is a granted per-user capability"
```

---

### Task 2: Admin team routes

**Files:**
- Modify: `services/cti-api/src/routes/admin.ts` (append after the `/admin/reps` route at ~:81-96)
- Test: create `services/cti-api/src/routes/admin-team.test.ts`

**Interfaces:**
- Consumes: `resolveSession` with `powerDialerEnabled` (Task 1); `schema.users.powerDialerEnabled` (Task 1); admin.ts's existing imports (`and, eq`, `z`, `resolveSession`, `getDb, schema`) — all already imported.
- Produces: `GET /admin/team` → `{ users: [{ id, email, displayName, isAdmin, inboundEnabled, powerDialerEnabled }] }`; `PATCH /admin/team/:userId` body `{ powerDialerEnabled: boolean }` → `{ user: { id, powerDialerEnabled } }`. Task 3's `team-api.ts` calls these.

- [ ] **Step 1: Write the failing tests**

Create `services/cti-api/src/routes/admin-team.test.ts`, following `dialer-handoffs.test.ts`'s harness idiom (hoisted `state`, `vi.mock` of `../auth/session.js` and `../db/index.js`, Fastify + `registerAdminRoutes`). Copy the `renderPredicate` helper VERBATIM from `src/routes/mobile.test.ts` (~:72-90) — it renders a drizzle predicate's `queryChunks` to text. Fake db needs: `select().from().where().orderBy()` returning a fixed array (record the `where` argument), and `update().set().where().returning()` (record `set` and `where` arguments, return a configurable row array).

```ts
describe('GET /admin/team', () => {
  it('401 without a session, 403 for a non-admin', async () => {
    state.authedUser = null;
    expect((await app.inject({ method: 'GET', url: '/admin/team' })).statusCode).toBe(401);
    state.authedUser = { ...admin, isAdmin: false };
    expect((await app.inject({ method: 'GET', url: '/admin/team' })).statusCode).toBe(403);
  });

  it('an admin gets the org users incl. both flags, and the query is org-scoped', async () => {
    state.authedUser = admin;
    const res = await app.inject({ method: 'GET', url: '/admin/team' });
    expect(res.statusCode).toBe(200);
    expect(res.json().users[0]).toMatchObject({ email: 'rep@x.com', powerDialerEnabled: false, inboundEnabled: true });
    expect(renderPredicate(capturedSelectWhere)).toContain('org_id');
  });
});

describe('PATCH /admin/team/:userId', () => {
  it('403 for non-admins; 400 for a non-boolean body; 404 for a non-uuid id', async () => { /* three injects as above */ });

  it('flips the flag and the WHERE pins BOTH user id AND org id (IDOR-proof)', async () => {
    state.authedUser = admin;
    const res = await app.inject({
      method: 'PATCH', url: `/admin/team/${targetId}`, payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ id: targetId, powerDialerEnabled: true });
    const where = renderPredicate(capturedUpdateWhere);
    expect(where).toContain('"users"."id"');
    expect(where).toContain('"users"."org_id"');
    expect(where).toContain(' and ');
  });

  it('404 when the target is in another org (update matches no row)', async () => { /* returning → [] ⇒ 404 */ });
});
```

(Write the elided cases in full in the test file — each is a 3–6 line inject+expect. `admin` fixture: `{ userId: 'a1', orgId: 'o1', email: 'admin@x.com', isAdmin: true, powerDialerEnabled: false }` — note an admin WITHOUT the power flag can still administer it; the routes check `isAdmin` only.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/routes/admin-team.test.ts`
Expected: FAIL — 404s (routes don't exist).

- [ ] **Step 3: Implement the routes**

Append to `registerAdminRoutes` in `services/cti-api/src/routes/admin.ts`:

```ts
  // ---- team: power-dialer enablement (spec 2026-08-25) ----
  app.get('/admin/team', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const db = getDb();
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        isAdmin: schema.users.isAdmin,
        inboundEnabled: schema.users.inboundEnabled,
        powerDialerEnabled: schema.users.powerDialerEnabled,
      })
      .from(schema.users)
      .where(eq(schema.users.orgId, s.orgId))
      .orderBy(schema.users.displayName);
    return { users: rows };
  });

  app.patch('/admin/team/:userId', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const params = z.object({ userId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Not found' });
    const body = z.object({ powerDialerEnabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const db = getDb();
    // Org-scoped in the WHERE itself (IDOR-proof, same shape as the mobile
    // device routes): an admin can only flip users in their own org.
    const [updated] = await db
      .update(schema.users)
      .set({ powerDialerEnabled: body.data.powerDialerEnabled })
      .where(and(eq(schema.users.id, params.data.userId), eq(schema.users.orgId, s.orgId)))
      .returning({ id: schema.users.id, powerDialerEnabled: schema.users.powerDialerEnabled });
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    req.log.info(
      { actor: s.userId, target: updated.id, powerDialerEnabled: updated.powerDialerEnabled },
      'power_dialer_enabled changed',
    );
    return { user: updated };
  });
```

- [ ] **Step 4: Run tests + gates**

Run: `npx vitest run src/routes/admin-team.test.ts` → PASS. Then `npx tsc --noEmit && npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/routes/admin.ts services/cti-api/src/routes/admin-team.test.ts
git commit -m "feat(cti-api): admin team routes to grant/revoke power dialing"
```

---

### Task 3: Softphone — nav gating + Team panel

**Files:**
- Modify: `apps/cti-web/src/nav.ts`, `apps/cti-web/src/nav.test.ts`
- Create: `apps/cti-web/src/team-api.ts`, `apps/cti-web/src/components/TeamPanel.tsx`, `apps/cti-web/src/components/TeamPanel.test.tsx`
- Modify: `apps/cti-web/src/App.tsx` (`MeResponse` at :37; `iconFor` at ~:1229; `navTabsFor` call at :1238; the panel switch at ~:1188)

**Interfaces:**
- Consumes: `GET /admin/team` / `PATCH /admin/team/:userId` (Task 2 shapes, verbatim); `/auth/me` now returns `user.powerDialerEnabled` (Task 1); the web `api<T>(path, { method, body })` helper from `./api`.
- Produces: `navTabsFor(user: { isAdmin: boolean; powerDialerEnabled: boolean }): NavTab[]`; new `Tab` id `'team'` with label `'Team'` in `NAV_OVERFLOW_IDS`.

- [ ] **Step 1: Rewrite `nav.test.ts` (failing)**

Replace the boolean-arg expectations:

```ts
import { describe, expect, it } from 'vitest';
import { navTabsFor, NAV_OVERFLOW_IDS } from './nav';

const rep = { isAdmin: false, powerDialerEnabled: false };

describe('navTabsFor', () => {
  it('a rep without power dial sees only Dial/Recent/Settings', () => {
    expect(navTabsFor(rep).map((t) => t.id)).toEqual(['dialer', 'recent', 'settings']);
  });

  it('power dial appears only when granted — for reps AND admins', () => {
    expect(navTabsFor({ ...rep, powerDialerEnabled: true }).map((t) => t.id))
      .toEqual(['dialer', 'powerdial', 'recent', 'settings']);
    // An admin WITHOUT the grant does not get the tab either (flag ⊥ admin).
    expect(navTabsFor({ isAdmin: true, powerDialerEnabled: false }).map((t) => t.id))
      .not.toContain('powerdial');
  });

  it('admins get Team in the More overflow, beside Reputation', () => {
    const ids = navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => t.id);
    expect(ids).toEqual(['dialer', 'powerdial', 'recent', 'team', 'reputation', 'admin', 'calls', 'settings']);
    expect(NAV_OVERFLOW_IDS).toEqual(['team', 'reputation', 'admin', 'calls']);
  });

  it('labels are stable', () => {
    const byId = Object.fromEntries(navTabsFor({ isAdmin: true, powerDialerEnabled: true }).map((t) => [t.id, t.label]));
    expect(byId).toMatchObject({ team: 'Team', admin: 'Numbers', reputation: 'Reputation', dialer: 'Dial' });
  });
});
```

Run: `cd apps/cti-web && npx vitest run src/nav.test.ts` → FAIL.

- [ ] **Step 2: Implement `nav.ts`**

```ts
export type Tab = 'dialer' | 'powerdial' | 'recent' | 'team' | 'reputation' | 'admin' | 'calls' | 'settings';

export interface NavTab {
  id: Tab;
  label: string;
}

/** Tabs tucked under the "More" overflow — the admin-only tools. */
export const NAV_OVERFLOW_IDS: readonly Tab[] = ['team', 'reputation', 'admin', 'calls'];

/**
 * The bottom-nav tabs for a given rep. Power Dial is a GRANTED capability
 * (independent of admin — the dialer endpoints 403 without it); Team,
 * Reputation, Numbers and Calls are admin-only.
 */
export function navTabsFor(user: { isAdmin: boolean; powerDialerEnabled: boolean }): NavTab[] {
  return [
    { id: 'dialer', label: 'Dial' },
    ...(user.powerDialerEnabled ? ([{ id: 'powerdial', label: 'Power Dial' }] as NavTab[]) : []),
    { id: 'recent', label: 'Recent' },
    ...(user.isAdmin
      ? ([
          { id: 'team', label: 'Team' },
          { id: 'reputation', label: 'Reputation' },
          { id: 'admin', label: 'Numbers' },
          { id: 'calls', label: 'Calls' },
        ] as NavTab[])
      : []),
    { id: 'settings', label: 'Settings' },
  ];
}
```

Run: `npx vitest run src/nav.test.ts` → PASS.

- [ ] **Step 3: `team-api.ts`**

```ts
import { api } from './api';

export interface TeamUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  inboundEnabled: boolean;
  powerDialerEnabled: boolean;
}

/** Admin-only: the org's users with their capability flags. */
export async function listTeam(): Promise<{ users: TeamUser[] }> {
  return api('/admin/team', { method: 'GET' });
}

/** Admin-only: grant/revoke power dialing for one user. */
export async function setPowerDialer(
  userId: string,
  powerDialerEnabled: boolean,
): Promise<{ user: { id: string; powerDialerEnabled: boolean } }> {
  return api(`/admin/team/${userId}`, { method: 'PATCH', body: { powerDialerEnabled } });
}
```

- [ ] **Step 4: `TeamPanel.tsx` test (failing)**

`apps/cti-web/src/components/TeamPanel.test.tsx`, following `MobilePairingCard.test.tsx`'s render/mocking idiom (read it first; it mocks the api module and uses testing-library):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamPanel } from './TeamPanel';
import * as teamApi from '../team-api';

vi.mock('../team-api');

const users = [
  { id: 'u1', email: 'rep@x.com', displayName: 'Ada Rep', isAdmin: false, inboundEnabled: true, powerDialerEnabled: false },
  { id: 'u2', email: 'boss@x.com', displayName: 'Bea Boss', isAdmin: true, inboundEnabled: true, powerDialerEnabled: true },
];

beforeEach(() => {
  vi.mocked(teamApi.listTeam).mockResolvedValue({ users });
  vi.mocked(teamApi.setPowerDialer).mockImplementation(async (id, v) => ({ user: { id, powerDialerEnabled: v } }));
});

describe('TeamPanel', () => {
  it('lists the org users with their flags', async () => {
    render(<TeamPanel />);
    expect(await screen.findByText('Ada Rep')).toBeTruthy();
    expect(screen.getByText('Bea Boss')).toBeTruthy();
  });

  it('toggling a user PATCHes and flips optimistically', async () => {
    render(<TeamPanel />);
    const toggle = (await screen.findAllByRole('switch'))[0]!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(teamApi.setPowerDialer).toHaveBeenCalledWith('u1', true);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('a failed PATCH reverts the toggle', async () => {
    vi.mocked(teamApi.setPowerDialer).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    const toggle = (await screen.findAllByRole('switch'))[0]!;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });
});
```

Run: `npx vitest run src/components/TeamPanel.test.tsx` → FAIL (component missing).

- [ ] **Step 5: Implement `TeamPanel.tsx`**

Reuse the settings-card classes (`set-list`, `set-row`, `label`, `name`, `sub`, `btn`) seen in `MobilePairingCard.tsx` so it matches the app's look:

```tsx
import { useEffect, useState } from 'react';
import { listTeam, setPowerDialer, type TeamUser } from '../team-api';

/** Admin-only Team panel: grant/revoke Power Dialer per user. The server gate
 *  (403 power_dialer_disabled) is authoritative and instant; the rep's own tab
 *  bar updates on their next /auth/me refresh. */
export function TeamPanel() {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTeam().then((r) => setUsers(r.users)).catch(() => setError('Could not load the team.'));
  }, []);

  async function toggle(u: TeamUser) {
    const next = !u.powerDialerEnabled;
    setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: next } : x)));
    try {
      await setPowerDialer(u.id, next);
    } catch {
      setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: u.powerDialerEnabled } : x)));
      setError(`Could not update ${u.displayName ?? u.email}.`);
    }
  }

  if (error && !users) return <div className="set-list"><div className="set-row"><div className="sub">{error}</div></div></div>;
  if (!users) return <div className="set-list"><div className="set-row"><div className="sub">Loading…</div></div></div>;

  return (
    <div className="set-list">
      {error ? <div className="set-row"><div className="sub">{error}</div></div> : null}
      {users.map((u) => (
        <div className="set-row" key={u.id}>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="name">{u.displayName ?? u.email}</div>
            <div className="sub">
              {u.email}
              {u.isAdmin ? ' · Admin' : ''}
              {u.inboundEnabled ? ' · Inbound' : ''}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={u.powerDialerEnabled}
            aria-label={`Power Dialer for ${u.displayName ?? u.email}`}
            className={`btn ${u.powerDialerEnabled ? 'primary' : 'ghost'}`}
            onClick={() => void toggle(u)}
          >
            {u.powerDialerEnabled ? 'Power Dialer: On' : 'Power Dialer: Off'}
          </button>
        </div>
      ))}
    </div>
  );
}
```

Run: `npx vitest run src/components/TeamPanel.test.tsx` → PASS.

- [ ] **Step 6: Wire `App.tsx`**

1. `MeResponse` (:37): add `powerDialerEnabled: boolean;` to the `user` object type.
2. `iconFor` (~:1229): add a `team` entry reusing an existing icon component from `icons.tsx` (pick the people/user glyph if present; otherwise reuse the Settings person icon — read `icons.tsx` and choose).
3. Nav call (:1238): `const navItems = navTabsFor(me.user).map(…)` — pass the user object.
4. Panel switch (~:1188): render `<TeamPanel />` for `tab === 'team'`, alongside the reputation/admin branches; import it.
5. Anywhere a gated dialer call's error surfaces (the Power Dial screen's start-run error handler): map `power_dialer_disabled` → `"Power dialing isn't enabled for your account."` (grep `powerdial` screen's catch; add the mapping where other API errors become toasts).

- [ ] **Step 7: Gates**

Run: `cd apps/cti-web && npx tsc --noEmit && npm test && npm run build` → all green. Any other `navTabsFor(boolean)` caller the compiler finds gets the object form.

- [ ] **Step 8: cti-desktop check (report, don't restyle)**

Run: `rg -l "navTabsFor|powerdial" apps/cti-desktop/src` — if it renders a Power Dial tab, apply the same object-arg gating there (mirroring the diff from steps 1–2 only); if it doesn't compile against shared code, note the divergence in the task report. The server gate protects regardless.

- [ ] **Step 9: Commit**

```bash
git add apps/cti-web/src apps/cti-desktop 2>/dev/null; git add apps/cti-web/src
git commit -m "feat(cti-web): Power Dial tab is grant-gated; admin Team panel to manage it"
```

---

### Task 4: Call-center swap script + runbook

**Files:**
- Create: `services/cti-api/scripts/swap-call-center.mjs`
- Create: `docs/runbooks/cti-swap.md`

**Interfaces:**
- Consumes: CTI users table (roster = all non-admin AND admin users' emails — DB-derived, never hardcoded, per the fleet-script convention); sf CLI (`sf data query`, `sf data update record`) against org alias `_t2` (PRODUCTION — gghsd.my.salesforce.com; `gghsd-maindev` is the sandbox, never target it).
- Produces: a runnable, idempotent swap with recorded rollback.

- [ ] **Step 1: Write the script**

`services/cti-api/scripts/swap-call-center.mjs`:

```js
/**
 * Swap every CTI rep's Salesforce Call Center to Caller Reputation CTI.
 * Roster is DERIVED from the CTI users table (never hardcoded), matched to
 * SF Users by Email (usernames are 2-suffixed for several reps — match on
 * the Email FIELD, not Username). Idempotent: re-runs are no-ops.
 *
 * Usage:
 *   node scripts/swap-call-center.mjs             # dry run: prints the plan
 *   node scripts/swap-call-center.mjs --apply     # writes; records rollback json
 *   node scripts/swap-call-center.mjs --rollback swap-rollback-<ts>.json
 *
 * Env: DATABASE_URL (public), SF_ORG (default "_t2" = PRODUCTION).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import pg from 'pg';

const ORG = process.env.SF_ORG ?? '_t2';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.indexOf('--rollback');

function soql(q) {
  const out = execFileSync('sf', ['data', 'query', '-o', ORG, '-q', q, '--json'], { encoding: 'utf8' });
  return JSON.parse(out).result.records;
}
function sfUpdate(id, callCenterId) {
  execFileSync('sf', [
    'data', 'update', 'record', '-o', ORG, '-s', 'User', '-i', id,
    '-v', `CallCenterId='${callCenterId ?? ''}'`, '--json',
  ], { encoding: 'utf8' });
}

if (ROLLBACK !== -1) {
  const file = process.argv[ROLLBACK + 1];
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (const row of saved) {
    sfUpdate(row.sfId, row.previousCallCenterId);
    console.log(`rolled back ${row.email} -> ${row.previousCallCenterId ?? '(none)'}`);
  }
  process.exit(0);
}

const [target] = soql("SELECT Id, InternalName FROM CallCenter WHERE InternalName = 'CallerReputationCTI'");
if (!target) throw new Error('CallerReputationCTI call center not found in org');

const c = new pg.Client({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: ctiUsers } = await c.query('select email from users order by email');
await c.end();

const emails = ctiUsers.map((u) => u.email.toLowerCase());
const inList = emails.map((e) => `'${e.replace(/'/g, "\\'")}'`).join(',');
const sfUsers = soql(`SELECT Id, Email, Name, CallCenterId FROM User WHERE IsActive = true AND Email IN (${inList})`);

const missing = emails.filter((e) => !sfUsers.some((u) => u.Email?.toLowerCase() === e));
if (missing.length) console.log(`no active SF user for: ${missing.join(', ')}`);

const plan = sfUsers.map((u) => ({
  sfId: u.Id, email: u.Email, name: u.Name,
  previousCallCenterId: u.CallCenterId ?? null,
  alreadyDone: u.CallCenterId === target.Id,
}));
for (const p of plan) {
  console.log(`${p.alreadyDone ? 'ok    ' : 'swap  '} ${p.name} <${p.email}>`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — ${plan.filter((p) => !p.alreadyDone).length} to change. Re-run with --apply.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`swap-rollback-${stamp}.json`, JSON.stringify(plan, null, 2));
for (const p of plan.filter((x) => !x.alreadyDone)) {
  sfUpdate(p.sfId, target.Id);
  console.log(`swapped ${p.email}`);
}
const verify = soql(`SELECT Email, CallCenterId FROM User WHERE IsActive = true AND Email IN (${inList})`);
const bad = verify.filter((u) => u.CallCenterId !== target.Id);
console.log(bad.length ? `VERIFY FAILED for: ${bad.map((u) => u.Email).join(', ')}` : `VERIFIED: all ${verify.length} users on CallerReputationCTI`);
```

- [ ] **Step 2: Dry-run it**

Run (dry run only in this task — the APPLY is a runbook step performed at swap time, after this feature deploys):

```bash
cd services/cti-api && PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-) && env DATABASE_URL="$PUB" node scripts/swap-call-center.mjs
```

Expected: a `swap`/`ok` line per rep, `DRY RUN — N to change`, exit 0. Fix any SOQL/roster issues until the dry run is clean. NEVER pass `--apply` during implementation.

- [ ] **Step 3: Write `docs/runbooks/cti-swap.md`**

Sections (write each fully):
1. **Preconditions** — this feature deployed to prod (migration 0029 applied: `select filename from cti_schema_migrations where filename = '0029_power_dialer_enabled.sql'` via the `$PUB` pattern from `docs/runbooks/caller-id-app.md` §2a); nobody expects power dial on day one (all flags start false).
2. **The swap** — the dry-run + `--apply` commands from Step 2, what the output means, and that the rollback JSON must be kept.
3. **Enablement** — softphone → More → Team → toggle Power Dialer per user; note the rep sees the tab after their next reload/login; the server gate is instant.
4. **Salesforce parity** — assign/remove the list-view dial LWC's permission set for the same people (name the permset by reading it from the SF org at runbook-execution time: `sf org list metadata -m PermissionSet -o _t2` and pick the dialer one); the server 403 is authoritative — the permset only controls button visibility.
5. **Rollback** — `node scripts/swap-call-center.mjs --rollback swap-rollback-<ts>.json` restores every user's previous call center.
6. **Verify** — the script's own VERIFY line, plus one rep confirming the new softphone pops on an inbound call.

- [ ] **Step 4: Commit**

```bash
git add services/cti-api/scripts/swap-call-center.mjs docs/runbooks/cti-swap.md
git commit -m "feat(cti): call-center swap script + runbook for the full CTI cutover"
```

---

## Execution order

Tasks 1 → 2 → 3 → 4 (each depends on its predecessor's interfaces; Task 4 only needs Task 1's migration name).
