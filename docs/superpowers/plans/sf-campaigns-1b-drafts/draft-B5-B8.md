<!-- Draft of tasks B5–B8 for plan 1B (docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md). Verification status of the code blocks:
- B5 ran in full against apps/cti-web at fa78987, with B4's contracts shimmed. The cti-web suite went from 57 files / 912 tests to 59 / 928, and the typecheck was clean.
- B6 ran on Postgres 17 with a stand-in for the A3 tables. That covers reconcile.ts and both reconcile test files.
- B7 ran the same way for config, alerts, pause.ts, pause.pg.test.ts, kill-switch.pg.test.ts, routes/status.ts and the outreach-web banner.
- B7 code that edits files A8/A9/A10/B2/B4 have not produced yet was written against their drafts and was not run: pause-alerts.pg.test.ts, kill-switch.test.ts, the cti-api kill-switch test, and every server.ts and refresh/triage/outbox edit.
- B8's railway.ts edit was typechecked. The .env.example test ran against the pre-A5 config. -->

### Task B5: cti-web — Campaign calls picker

A rep starts campaign calls from the softphone's Power dial tab. Below the list-view picker, a "Campaign calls" picker lists the tenant's active campaigns with rep calls due now. "Dial campaign calls" starts a normal READY run through B4's `POST /dialer/sessions/from-campaign`, with the same confirm block and the same gates. The picker renders nothing when nothing is due or the list cannot be loaded, so a tenant with no campaigns sees the softphone exactly as before.

**Files:**
- Create:
  - `apps/cti-web/src/components/CampaignCallsPicker.tsx`
  - `apps/cti-web/src/components/CampaignCallsPicker.test.tsx`
  - `apps/cti-web/src/dialer-api.campaign-calls.test.ts`
- Modify `apps/cti-web/src/dialer-api.ts`:
  - lines 1–2 (imports)
  - append after line 192 (the end of the file)
- Modify `apps/cti-web/src/components/DialerPanel.tsx`:
  - lines 2–3 (header comment)
  - insert after line 37 (import)
  - insert after line 560 (prop)
  - line 937 (destructure)
  - line 1227 (idle render)
- Modify `apps/cti-web/src/App.tsx`:
  - lines 23–33 (the `./dialer-api` import)
  - insert after line 1398 (the end of `startPowerDialFromListView`)
  - insert after line 2255 (`onStartFromListView={startPowerDialFromListView}`)

Line numbers are at fa78987. cti-web is edited live by another session, so check each anchor before you edit it:
```bash
grep -n "import { RunSettingsBlock }\|onStartFromListView: (object\|sessionId, onScreenPop, onStartFromListView\|return <ListViewPicker onStart" apps/cti-web/src/components/DialerPanel.tsx
grep -n "^  startDialerFromListView,\|const startPowerDialFromListView\|onStartFromListView={startPowerDialFromListView}" apps/cti-web/src/App.tsx
```

**Interfaces:**
- **Consumes:**
  - From B4 `@cti/contracts`: the value `CampaignCallsResponse` (`{ campaigns: Array<{ id: uuid; name: string; sfObject: 'Lead' | 'Opportunity'; due: number }> }`).
  - B4 cti-api routes:
    - `GET /dialer/campaigns` → `CampaignCallsResponse`
    - `POST /dialer/sessions/from-campaign` with `{ campaignId }` → `{ sessionId, total }`. It answers 404 when nothing is due and 502 when the build failed.
  - From cti-web `./api`: `api(path, { method, body })` and `class ApiError { status; body }`.
  - In `App.tsx`: `beginRun`, `refreshMe`, `setToast` and `dialerStartErrorMessage`.
- **Produces:**
  - `dialer-api.ts`:
    - `getCampaignCalls(): Promise<CampaignCallsResponse>`
    - `startDialerFromCampaign(campaignId: string): Promise<{ sessionId: string; total: number }>`
    - `campaignStartErrorText(e: unknown): string | null`
  - `components/CampaignCallsPicker.tsx`:
    - `campaignDueLabel(c: { due: number; sfObject: 'Lead' | 'Opportunity' }): string`
    - `CampaignCallsPicker({ onStart }: { onStart: (campaignId: string) => Promise<void> }): JSX.Element | null`
  - `DialerPanelProps.onStartFromCampaign?: (campaignId: string) => Promise<void>`
  - `App.tsx` `startPowerDialFromCampaign`

- [ ] **Step 1: Write the failing tests**

Create `apps/cti-web/src/dialer-api.campaign-calls.test.ts`:
```ts
/**
 * The two Campaign calls API calls (plan 1B task B5) and the 404 toast text.
 * Same idiom as dialer-api.test.ts: `api` is spied, nothing hits the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignStartErrorText, getCampaignCalls, startDialerFromCampaign } from './dialer-api';
import * as apiModule from './api';
import { ApiError } from './api';

const SPRING = { id: '11111111-1111-4111-8111-111111111111', name: 'Spring sellers', sfObject: 'Lead', due: 12 };

afterEach(() => { vi.restoreAllMocks(); });

describe('getCampaignCalls', () => {
  it('GETs /dialer/campaigns and returns the parsed list', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ campaigns: [SPRING] });
    expect(await getCampaignCalls()).toEqual({ campaigns: [SPRING] });
    expect(mockApi).toHaveBeenCalledWith('/dialer/campaigns', { method: 'GET' });
  });

  it('rejects a body that is not a campaign list (an older server answers {} or an HTML page)', async () => {
    vi.spyOn(apiModule, 'api').mockResolvedValue({});
    await expect(getCampaignCalls()).rejects.toThrow();
    vi.spyOn(apiModule, 'api').mockResolvedValue({ campaigns: [{ ...SPRING, id: 'not-a-uuid' }] });
    await expect(getCampaignCalls()).rejects.toThrow();
  });
});

describe('startDialerFromCampaign', () => {
  it('POSTs the campaign id to /dialer/sessions/from-campaign', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ sessionId: 'sess-9', total: 12 });
    expect(await startDialerFromCampaign(SPRING.id)).toEqual({ sessionId: 'sess-9', total: 12 });
    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/from-campaign', { method: 'POST', body: { campaignId: SPRING.id } });
  });
});

describe('campaignStartErrorText', () => {
  it('names the race when nothing is due any more (404)', () => {
    expect(campaignStartErrorText(new ApiError(404, { error: 'nothing due' })))
      .toBe('No campaign calls are due right now. Another rep may have just started them.');
  });

  it('leaves every other failure to the generic dialer message', () => {
    expect(campaignStartErrorText(new ApiError(403, { error: 'power_dialer_disabled' }))).toBeNull();
    expect(campaignStartErrorText(new ApiError(502, { error: 'build failed' }))).toBeNull();
    expect(campaignStartErrorText(new Error('network'))).toBeNull();
  });
});
```

Create `apps/cti-web/src/components/CampaignCallsPicker.test.tsx`:
```tsx
/** @vitest-environment jsdom */
/**
 * Campaign calls picker (spec 2026-10-04 §10.1, plan 1B task B5): lists the
 * campaigns with rep calls due, starts the chosen one through the parent's
 * `onStartFromCampaign`, and stays out of the way — renders nothing — when
 * nothing is due or the list cannot be loaded. Also pins DialerPanel's idle
 * state: the list-view picker first, then this picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignCallsPicker, campaignDueLabel } from './CampaignCallsPicker';
import { DialerPanel } from './DialerPanel';
import * as dialerApi from '../dialer-api';

const SPRING = { id: '11111111-1111-4111-8111-111111111111', name: 'Spring sellers', sfObject: 'Lead' as const, due: 12 };
const PROBATE = { id: '22222222-2222-4222-8222-222222222222', name: 'Probate', sfObject: 'Opportunity' as const, due: 1 };
const noop = () => {};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('campaignDueLabel', () => {
  it.each([
    [{ due: 12, sfObject: 'Lead' as const }, '12 Leads due'],
    [{ due: 1, sfObject: 'Lead' as const }, '1 Lead due'],
    [{ due: 1, sfObject: 'Opportunity' as const }, '1 Opportunity due'],
    [{ due: 3, sfObject: 'Opportunity' as const }, '3 Opportunities due'],
  ])('%o → %s', (input, expected) => {
    expect(campaignDueLabel(input)).toBe(expected);
  });
});

describe('CampaignCallsPicker', () => {
  it('lists every campaign with calls due, with its due count', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING, PROBATE] });
    render(<CampaignCallsPicker onStart={async () => {}} />);
    expect(await screen.findByText('Campaign calls')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Spring sellers · 12 Leads due' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Probate · 1 Opportunity due' })).toBeTruthy();
  });

  it('starts the first campaign by default, and the one the rep picks after that', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING, PROBATE] });
    const onStart = vi.fn(async () => {});
    render(<CampaignCallsPicker onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(SPRING.id));

    fireEvent.change(screen.getByRole('combobox', { name: 'Campaign' }), { target: { value: PROBATE.id } });
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStart).toHaveBeenLastCalledWith(PROBATE.id));
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('disables the button while the run is being built', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    let finish: () => void = noop;
    const onStart = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<CampaignCallsPicker onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    const busy = await screen.findByRole('button', { name: 'Building the run…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    expect(await screen.findByRole('button', { name: 'Dial campaign calls' })).toBeTruthy();
  });

  it('renders nothing when no campaign has calls due', async () => {
    const spy = vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [{ ...SPRING, due: 0 }] });
    const { container } = render(<CampaignCallsPicker onStart={async () => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing, and logs, when the list cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
    const failure = new Error('API 500: {"error":"boom"}');
    vi.spyOn(dialerApi, 'getCampaignCalls').mockRejectedValue(failure);
    const { container } = render(<CampaignCallsPicker onStart={async () => {}} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('[campaign-calls]'), failure));
    expect(container.innerHTML).toBe('');
  });
});

describe('DialerPanel idle state', () => {
  const props = {
    onScreenPop: noop, onStartFromListView: async () => {}, onPrepare: async () => {},
    onJoin: async () => true, onStop: noop, onComplete: noop, onDismiss: noop,
  };

  it('renders the list-view picker, then the Campaign calls picker, which starts through onStartFromCampaign', async () => {
    vi.spyOn(dialerApi, 'getSalesforceListViews').mockResolvedValue({ listViews: [] });
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    const onStartFromCampaign = vi.fn(async () => {});
    render(<DialerPanel sessionId={null} {...props} onStartFromCampaign={onStartFromCampaign} />);
    await screen.findByText('Campaign calls');
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Power dial a list')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Power dial a list')).toBeLessThan(text.indexOf('Campaign calls'));
    fireEvent.click(screen.getByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStartFromCampaign).toHaveBeenCalledWith(SPRING.id));
  });

  it('without onStartFromCampaign: only the list-view picker, and no campaign request', async () => {
    vi.spyOn(dialerApi, 'getSalesforceListViews').mockResolvedValue({ listViews: [] });
    const campaigns = vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    render(<DialerPanel sessionId={null} {...props} />);
    await screen.findByText('Power dial a list');
    expect(screen.queryByText('Campaign calls')).toBeNull();
    expect(campaigns).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

B4 must be merged first, because `CampaignCallsResponse` comes from `@cti/contracts`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w apps/cti-web run test -- src/components/CampaignCallsPicker.test.tsx src/dialer-api.campaign-calls.test.ts 2>&1 | tail -20
```
Expected: `Test Files  2 failed (2)`.
- `CampaignCallsPicker.test.tsx` fails to load with `Failed to resolve import "./CampaignCallsPicker" from "src/components/CampaignCallsPicker.test.tsx". Does the file exist?`.
- The dialer-api file runs, and its 5 tests fail with `TypeError: … getCampaignCalls is not a function` (and the same error for the other two functions).

- [ ] **Step 3: Add the API calls to `dialer-api.ts`**

In `apps/cti-web/src/dialer-api.ts`, replace lines 1–2:
```ts
import type { DialerPasses, DialerRunSettings, RolloverBusinessDays } from '@cti/contracts';
import { api } from './api';
```
with:
```ts
import { CampaignCallsResponse, type DialerPasses, type DialerRunSettings, type RolloverBusinessDays } from '@cti/contracts';
import { api, ApiError } from './api';
```
Append to the end of the file, after line 192, the closing brace of `takeDialerCallback`:
```ts

/** Outreach campaigns with rep calls due now (spec 2026-10-04 §10.1). The
 *  body is parsed: anything else (an older server, a proxy's error page)
 *  throws, and the Campaign calls picker stays hidden. */
export async function getCampaignCalls(): Promise<CampaignCallsResponse> {
  return CampaignCallsResponse.parse(await api('/dialer/campaigns', { method: 'GET' }));
}

/** Claim a campaign's due calls and create a READY run over their records —
 *  nothing dials until dialerControl(id, 'start'). The server answers 404
 *  when nothing is due any more (another rep started them first). */
export async function startDialerFromCampaign(campaignId: string): Promise<{ sessionId: string; total: number }> {
  return api('/dialer/sessions/from-campaign', {
    method: 'POST',
    body: { campaignId },
  });
}

/** The toast for a Campaign calls start that the generic dialer message
 *  would explain badly; null means "use the generic message". */
export function campaignStartErrorText(e: unknown): string | null {
  if (e instanceof ApiError && e.status === 404) {
    return 'No campaign calls are due right now. Another rep may have just started them.';
  }
  return null;
}
```

- [ ] **Step 4: Create the picker**

Create `apps/cti-web/src/components/CampaignCallsPicker.tsx`. It reuses the list-view picker's classes (`dialer-panel`, `section dp-picker`, `kicker`, `dp-picker-select`, `btn primary full`), so it needs no new CSS:
```tsx
/**
 * Campaign calls (spec 2026-10-04 §10.1): the outreach campaigns that have rep
 * calls due now. Choosing one builds a normal power-dial run over those
 * records (POST /dialer/sessions/from-campaign) — every dialer rule applies
 * unchanged (consent and DNC at build, calling hours, the FL/OK/WA/MD cap,
 * screening); the campaign adds no new path to a phone line.
 *
 * Hidden when nothing is due or the list cannot be loaded, so a softphone
 * whose tenant runs no campaigns looks exactly as it did before.
 */
import { useEffect, useState } from 'react';
import type { CampaignCallsResponse } from '@cti/contracts';
import { getCampaignCalls } from '../dialer-api';

type DueCampaign = CampaignCallsResponse['campaigns'][number];

/** Pure — "12 Leads due", "1 Opportunity due". */
export function campaignDueLabel(c: Pick<DueCampaign, 'due' | 'sfObject'>): string {
  const noun = c.sfObject === 'Lead'
    ? (c.due === 1 ? 'Lead' : 'Leads')
    : (c.due === 1 ? 'Opportunity' : 'Opportunities');
  return `${c.due} ${noun} due`;
}

export function CampaignCallsPicker({
  onStart,
}: {
  onStart: (campaignId: string) => Promise<void>;
}): JSX.Element | null {
  const [campaigns, setCampaigns] = useState<DueCampaign[]>([]);
  const [selected, setSelected] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCampaignCalls()
      .then((r) => {
        if (cancelled) return;
        const due = r.campaigns.filter((c) => c.due > 0);
        setCampaigns(due);
        setSelected(due[0]?.id ?? '');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCampaigns([]);
        console.warn('[campaign-calls] could not load campaigns with calls due', e);
      });
    return () => { cancelled = true; };
  }, []);

  if (campaigns.length === 0) return null;

  const dial = async (): Promise<void> => {
    if (!selected) return;
    setStarting(true);
    try {
      await onStart(selected);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Campaign calls</div>
        <select
          className="dp-picker-select"
          aria-label="Campaign"
          value={selected}
          disabled={starting}
          onChange={(e) => setSelected(e.target.value)}
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{`${c.name} · ${campaignDueLabel(c)}`}</option>
          ))}
        </select>
        <button className="btn primary full" disabled={!selected || starting} onClick={() => void dial()}>
          {starting ? 'Building the run…' : 'Dial campaign calls'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render it in DialerPanel's idle state**

In `apps/cti-web/src/components/DialerPanel.tsx`, replace lines 2–3:
```ts
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
```
with:
```ts
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it) and,
 * when the parent passes `onStartFromCampaign`, the Campaign calls picker
 * below it (outreach campaigns with rep calls due). During a
```
After line 37 (`import { RunSettingsBlock } from './RunSettingsBlock';`), insert:
```ts
import { CampaignCallsPicker } from './CampaignCallsPicker';
```
After line 560 (`  onStartFromListView: (object: DialerObjectType, listViewId: string) => Promise<void>;`), insert:
```ts
  /** Start a run from an outreach campaign's due calls (spec 2026-10-04
   *  §10.1; the parent creates the session). Absent: no Campaign calls picker. */
  onStartFromCampaign?: (campaignId: string) => Promise<void>;
```
On line 937, change `sessionId, onScreenPop, onStartFromListView, onPrepare,` to `sessionId, onScreenPop, onStartFromListView, onStartFromCampaign, onPrepare,`. The rest of the line stays the same.

Replace line 1227:
```tsx
    return <ListViewPicker onStart={onStartFromListView} />;
```
with:
```tsx
    return (
      <>
        <ListViewPicker onStart={onStartFromListView} />
        {onStartFromCampaign && <CampaignCallsPicker onStart={onStartFromCampaign} />}
      </>
    );
```

- [ ] **Step 6: Wire it in App.tsx**

In `apps/cti-web/src/App.tsx`, the `./dialer-api` import (lines 23–33) becomes:
```ts
import {
  campaignStartErrorText,
  dialerControl,
  getDialer,
  getPendingHandoff,
  startDialer,
  startDialerFromCampaign,
  startDialerFromListView,
  takeDialerCallback,
  type DialerObjectType,
  type DialerSession,
  type DialerSessionCounts,
} from './dialer-api';
```
This adds two lines, so `startPowerDialFromListView` now ends at line 1400 (`  );`). Insert this after it:
```tsx

  // Start a run from an outreach campaign's due calls (spec 2026-10-04
  // §10.1): the server claims the campaign's queued call touches and builds a
  // normal READY run over their records — same confirm block, same gates.
  const startPowerDialFromCampaign = useCallback(
    async (campaignId: string): Promise<void> => {
      try {
        // See startPowerDial's comment — same reasoning, same fix.
        const [{ sessionId }] = await Promise.all([
          startDialerFromCampaign(campaignId),
          refreshMe(),
        ]);
        beginRun(sessionId);
      } catch (e) {
        setToast({ text: campaignStartErrorText(e) ?? dialerStartErrorMessage(e), type: 'error' });
      }
    },
    [beginRun, refreshMe],
  );
```
On the `<DialerPanel` element, after the line `      onStartFromListView={startPowerDialFromListView}` (line 2255 before this task, about 2277 now; find it by its text), insert:
```tsx
      onStartFromCampaign={startPowerDialFromCampaign}
```

- [ ] **Step 7: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/cti-web run test -- src/components/CampaignCallsPicker.test.tsx src/dialer-api.campaign-calls.test.ts 2>&1 | tail -5
```
Expected: `Test Files  2 passed (2)` and `Tests  16 passed (16)`.

Now run the whole cti-web suite and its typecheck. Every existing test stays green: DialerPanel tests that render the idle state without the new prop get no picker and send no request. App tests that open the Power dial tab hit a failing or unstubbed `/dialer/campaigns`, so the picker hides itself.
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/cti-web run test 2>&1 | tail -5 && npm -w apps/cti-web run typecheck
```
Expected: no failures. Compared with a run before this task, there are 2 more test files and 16 more tests (at fa78987, 57 → 59 files and 912 → 928 tests). The typecheck is clean.

- [ ] **Step 8: Commit**
```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/dialer-api.campaign-calls.test.ts apps/cti-web/src/components/CampaignCallsPicker.tsx apps/cti-web/src/components/CampaignCallsPicker.test.tsx apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): Campaign calls picker starts a power-dial run from an outreach campaign"
```

---

### Task B6: outreach-api — `calls.reconcile` settles campaign call touches

When a rep starts Campaign calls, B4 claims the campaign's queued `rep_call` touches: status `dialing`, `claimed_at` set, `dialer_session_id` stamped by `attachSession`. The CTI dialer never learns about touches. It writes `dialer_queue_items` for (session, record), including the engine's attempt-2 retry rows. This tick reads those rows every minute and settles each claimed touch, then moves its enrollment on.

**Files:**
- Create `services/outreach-api/src/campaigns/reconcile.ts`.
- Create `services/outreach-api/src/campaigns/reconcile.test.ts`. It holds the pure, table-driven decision tests plus the queue and schedule wiring.
- Create `services/outreach-api/src/campaigns/reconcile.pg.test.ts` (real Postgres).
- Modify `services/outreach-api/src/jobs/queues.ts`: add one `QUEUES` entry after `'sf.write'` (B2).
- Modify `services/outreach-api/src/jobs/schedules.ts`: add one `SCHEDULES` entry after `'sf.write'`.
- Modify `services/outreach-api/src/jobs/schedules.test.ts`: A8's exact-list assertion gains the new entry.
- Modify `services/outreach-api/src/server.ts`: one import and one `handlers` entry.

**Interfaces:**
- **Consumes:**
  - A3 tables:
    - `touches`: `id`, `enrollment_id`, `seq`, `channel`, `status`, `outcome`, `skip_reason`, `sent_at`, `dialer_session_id`, `claimed_at`, `updated_at`
    - `campaign_enrollments`: `status`, `exit_reason`, `touches_done`, `next_touch_at`
    - `crm_records`: `sf_record_id`
    - `enrollment_contact_keys`: `active`, which is left alone
  - CTI tables:
    - `dialer_sessions`: `id`, `status` (one of `active|paused|stopped|done|ready`), `created_at`, `updated_at`
    - `dialer_queue_items`: `session_id`, `record_id` (the Salesforce Id passed to `createDialerSession`), `status` (one of `pending|dialing|connected|no_connect|skipped|unreachable|done`), `outcome`, `attempt`, `ordinal`
  - A10 `advanceAfterTouch(db: Db, touchId: string, now: Date): Promise<void>`. It acts only on a touch in `sent|failed|skipped` and only while `touches_done < seq`.
  - A8 `type RunnerLogger`, `TICK_QUEUE_OPTIONS` (`policy: 'stately'`), `QUEUES` and `SCHEDULES`.
  - From `src/test/pg.ts`: `createTestDb()`, `pgLane` and `type TestDb`.
  - B4's claim protocol:
    - claim: `queued` → `dialing` with `claimed_at = now`
    - `attachSession` stamps `dialer_session_id`
    - `releaseTouches` puts a touch back to `queued`
- **Produces:**
  - Constants: `STALE_CLAIM_MS` (10 min), `ENDED_RUN_GRACE_MS` (10 min), `ABANDONED_READY_MS` (2 h), `RECONCILE_BATCH` (1000), `NOT_IN_RUN` (`'not_in_run'`).
  - Types: `DialerItemStatus`, `DialerSessionStatus`, `ReconcileItem`, `ReconcileSession`, `ReconcileInput`, and `Resolution` (`connected | sent{outcome} | skipped{reason} | release | abandon | wait`).
  - `resolveCampaignTouch(input: ReconcileInput): Resolution` (pure).
  - `reconcileCampaignCalls(deps: { db: Db; now: Date; log: RunnerLogger; batch?: number }): Promise<{ resolved: number; released: number }>`.
  - The queue `calls.reconcile`, scheduled `* * * * *`.

**Rules the tick applies, in order:**

| Situation | Touch becomes | Enrollment |
|---|---|---|
| Any item for the record is `connected` or `done` (an item becomes `done` only from `connected`, when the rep presses Next, End call or Redial) | `sent`, outcome `connected` | becomes `conversing` if `active`. `next_touch_at` is cleared. `touches_done` + 1. Contact keys stay active. No `advanceAfterTouch`. |
| Every item settled, at least one `no_connect` | `sent`, outcome = the last miss's outcome (ordered by attempt, then ordinal), `no_connect` if it had none | `advanceAfterTouch` if `active`, else `touches_done` + 1 |
| Every item settled, no `no_connect`. This includes records `createDialerSession` gated at build: consent, opt-out, DNC, Skip on Dialer, already worked, unreachable. They arrive as settled `skipped`/`unreachable` rows and are never dialed | `skipped`, `skip_reason` = the first item's outcome, or its status when the outcome is null (`unreachable`) | same as above |
| The run exists but has **no** row for the record (the build dropped it; the run's rows are complete before B4 stamps the run on the touch) | `skipped`, `skip_reason` `not_in_run`. Releasing it instead would re-claim and re-drop it on every run | same as above |
| Run ended (`stopped`/`done`), an item still `dialing`, run updated < 10 min ago | waits for Twilio's status callback | — |
| Run ended, some items settled | settled as above | — |
| Run ended, nothing settled | released: `queued`, session and claim cleared. If the enrollment is no longer `active`, it becomes `skipped` with the enrollment's exit reason and `touches_done` + 1 | — |
| Run `ready` (never started) for 2 h | the run is stopped (compare-and-swap on `ready`), then released | — |
| The run row is gone | released | — |
| No run yet, claimed ≥ 10 min ago (a crash between claim and build) | released | — |
| Anything else (run active/paused with items pending, or a fresh claim) | waits | — |

Every write is a compare-and-swap on `status = 'dialing'` and the touch's own `dialer_session_id`, so a second tick, or a rep re-claiming a released touch, never double-counts. Nothing is written to Salesforce here: the dialer already logs connects (a call Task) and misses (Chatter).

- [ ] **Step 1: Write the failing pure tests**

Create `services/outreach-api/src/campaigns/reconcile.test.ts`:
```ts
/**
 * resolveCampaignTouch — the pure decision behind the `calls.reconcile` tick
 * (plan 1B task B6), table-driven over item-status combinations and run
 * statuses. The database half is pinned in reconcile.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { QUEUES, TICK_QUEUE_OPTIONS } from '../jobs/queues.js';
import { SCHEDULES } from '../jobs/schedules.js';
import {
  ABANDONED_READY_MS,
  ENDED_RUN_GRACE_MS,
  STALE_CLAIM_MS,
  resolveCampaignTouch,
  type DialerItemStatus,
  type DialerSessionStatus,
  type ReconcileInput,
  type ReconcileItem,
  type Resolution,
} from './reconcile.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const msAgo = (ms: number): Date => new Date(NOW.getTime() - ms);
const minAgo = (m: number): Date => msAgo(m * 60_000);
const item = (status: DialerItemStatus, outcome: string | null = null, attempt = 1, ordinal = 0): ReconcileItem => ({ status, outcome, attempt, ordinal });
const inRun = (status: DialerSessionStatus, items: ReconcileItem[], at: { createdAgoMs?: number; updatedAgoMs?: number } = {}): ReconcileInput => ({
  sessionId: 'S1',
  claimedAt: minAgo(30),
  session: { status, createdAt: msAgo(at.createdAgoMs ?? 30 * 60_000), updatedAt: msAgo(at.updatedAgoMs ?? 60_000) },
  items,
  now: NOW,
});

const CONNECTED: Resolution = { kind: 'connected' };
const WAIT: Resolution = { kind: 'wait' };
const RELEASE: Resolution = { kind: 'release' };
const sent = (outcome: string): Resolution => ({ kind: 'sent', outcome });
const skipped = (reason: string): Resolution => ({ kind: 'skipped', reason });

describe('resolveCampaignTouch', () => {
  it.each<[string, ReconcileInput, Resolution]>([
    // A person answered — whatever else happened, and whatever the run's state.
    ['connected, run active', inRun('active', [item('connected', 'connected')]), CONNECTED],
    ['connected then closed by Next (done)', inRun('active', [item('done', 'connected')]), CONNECTED],
    ['connected, run stopped mid-call', inRun('stopped', [item('connected', 'connected')]), CONNECTED],
    ['attempt-2 row for the same record counted: miss, then connect', inRun('done', [item('no_connect', 'voicemail', 1), item('done', 'connected', 2)]), CONNECTED],
    // Every item settled without a connect.
    ['one miss', inRun('done', [item('no_connect', 'voicemail')]), sent('voicemail')],
    ['two misses: the outcome is the last dial', inRun('done', [item('no_connect', 'voicemail', 1, 4), item('no_connect', 'no_answer', 2, 4)]), sent('no_answer')],
    ['a miss, then a dial-time skip of the retry', inRun('active', [item('no_connect', 'busy', 1), item('skipped', 'out_of_hours', 2)]), sent('busy')],
    ['a miss with no recorded reason', inRun('done', [item('no_connect', null)]), sent('no_connect')],
    ['build-time consent skip, run still ready', inRun('ready', [item('skipped', 'dnc_blocked')]), skipped('dnc_blocked')],
    ['dial-time skip', inRun('active', [item('skipped', 'out_of_hours')]), skipped('out_of_hours')],
    ['no number', inRun('active', [item('unreachable', null)]), skipped('unreachable')],
    ['skip and unreachable: the first item names it', inRun('done', [item('unreachable', null, 1, 2), item('skipped', 'already_worked', 1, 1)]), skipped('already_worked')],
    // Still in play.
    ['pending, run active', inRun('active', [item('pending')]), WAIT],
    ['dialing, run active', inRun('active', [item('dialing')]), WAIT],
    ['pending, run paused', inRun('paused', [item('pending')]), WAIT],
    ['a miss with its retry pending, run active', inRun('active', [item('no_connect', 'voicemail', 1), item('pending', null, 2)]), WAIT],
    ['dropped at build: no item for the record, run active', inRun('active', []), skipped('not_in_run')],
    ['pending, run ready for an hour', inRun('ready', [item('pending')], { createdAgoMs: 60 * 60_000 }), WAIT],
    // The run is over before it reached the record.
    ['pending, run stopped', inRun('stopped', [item('pending')]), RELEASE],
    ['pending, a limited run done', inRun('done', [item('pending')]), RELEASE],
    ['dropped at build: no item for the record, run done', inRun('done', []), skipped('not_in_run')],
    ['a miss with its retry never dialed, run stopped', inRun('stopped', [item('no_connect', 'no_answer', 1), item('pending', null, 2)]), sent('no_answer')],
    ['dialing in a run stopped moments ago waits for the status callback', inRun('stopped', [item('dialing')], { updatedAgoMs: ENDED_RUN_GRACE_MS - 1 }), WAIT],
    ['dialing in a run stopped 10 minutes ago is released', inRun('stopped', [item('dialing')], { updatedAgoMs: ENDED_RUN_GRACE_MS }), RELEASE],
    ['ready and never started for 2 hours', inRun('ready', [item('pending')], { createdAgoMs: ABANDONED_READY_MS }), { kind: 'abandon' }],
    // Claims with no run.
    ['the run row is gone', { sessionId: 'S1', claimedAt: minAgo(1), session: null, items: [], now: NOW }, RELEASE],
    ['claimed without a run, under 10 minutes', { sessionId: null, claimedAt: msAgo(STALE_CLAIM_MS - 1), session: null, items: [], now: NOW }, WAIT],
    ['claimed without a run, 10 minutes', { sessionId: null, claimedAt: msAgo(STALE_CLAIM_MS), session: null, items: [], now: NOW }, RELEASE],
    ['claimed without a run or a claim time', { sessionId: null, claimedAt: null, session: null, items: [], now: NOW }, RELEASE],
  ])('%s', (_name, input, expected) => {
    expect(resolveCampaignTouch(input)).toEqual(expected);
  });
});

describe('calls.reconcile wiring', () => {
  it('is a tick queue with the shared tick options', () => {
    expect(QUEUES.find((q) => q.name === 'calls.reconcile')?.options).toBe(TICK_QUEUE_OPTIONS);
  });
  it('runs every minute', () => {
    expect(SCHEDULES).toContainEqual({ queue: 'calls.reconcile', cron: '* * * * *' });
  });
});
```

- [ ] **Step 2: Write the failing real-Postgres test**

Create `services/outreach-api/src/campaigns/reconcile.pg.test.ts`. Each case gets its own tenant, run and queue items, inserted with raw SQL, the same rows the CTI dialer writes. Then one tick runs over all of them. `advanceAfterTouch` is wrapped, not replaced, so the test can see which touches advanced. The module mock spreads `importOriginal()`.
```ts
/**
 * calls.reconcile against real Postgres (plan 1B task B6): one tick over a
 * table of claimed campaign touches, each with its own tenant, run, and queue
 * items inserted directly — the rows the CTI dialer writes. Skipped unless
 * TEST_DATABASE_URL is set (root `npm run test:pg`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import type { DialerItemStatus, DialerSessionStatus } from './reconcile.js';

const advanced = vi.hoisted(() => [] as string[]);
vi.mock('../planner/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../planner/run.js')>();
  return {
    ...actual,
    advanceAfterTouch: async (db: Db, touchId: string, now: Date) => {
      advanced.push(touchId);
      return actual.advanceAfterTouch(db, touchId, now);
    },
  };
});

import { reconcileCampaignCalls } from './reconcile.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const minAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const OTHER_RECORD = '00Q0000000OTHER001';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface ItemSpec { status: DialerItemStatus; outcome?: string; attempt?: number; otherRecord?: boolean }
interface Case {
  name: string;
  run: DialerSessionStatus | null;
  runCreatedMinAgo?: number;
  runUpdatedMinAgo?: number;
  claimedMinAgo?: number;
  enrollment?: { status: 'exited'; exitReason: string };
  items: ItemSpec[];
  expectTouch: { status: 'sent' | 'skipped' | 'queued' | 'dialing'; outcome: string | null; skipReason: string | null; keepsRun: boolean };
  expectEnrollment: { status: string; touchesDone: number };
  expectAdvanced: boolean;
  expectRunStatus?: DialerSessionStatus;
}

const CASES: Case[] = [
  { name: 'connected → sent/connected, enrollment conversing, no advance', run: 'active', items: [{ status: 'connected', outcome: 'connected' }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'connected then Next (done) counts as connected', run: 'active', items: [{ status: 'done', outcome: 'connected' }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'attempt-2 row for the same record counted: miss, then connect', run: 'done', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'done', outcome: 'connected', attempt: 2 }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'all no_connect → sent with the last outcome', run: 'done', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'no_connect', outcome: 'no_answer', attempt: 2 }],
    expectTouch: { status: 'sent', outcome: 'no_answer', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: "another record's connect in the same run does not count", run: 'done', items: [{ status: 'no_connect', outcome: 'busy' }, { status: 'connected', outcome: 'connected', otherRecord: true }],
    expectTouch: { status: 'sent', outcome: 'busy', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'skipped at dial time → skipped with the reason', run: 'active', items: [{ status: 'skipped', outcome: 'out_of_hours' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'out_of_hours', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'unreachable → skipped unreachable', run: 'active', items: [{ status: 'unreachable' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'unreachable', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'consent skip at build while the run is still ready', run: 'ready', items: [{ status: 'skipped', outcome: 'dnc_blocked' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'dnc_blocked', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'record dropped at build (no queue row in its run) → skipped not_in_run', run: 'active', items: [{ status: 'pending', otherRecord: true }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'not_in_run', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'session stopped with pending items → released to queued', run: 'stopped', runUpdatedMinAgo: 5, items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a limited run done before the record → released to queued', run: 'done', items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a live run with the retry pending waits', run: 'active', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'pending', attempt: 2 }],
    expectTouch: { status: 'dialing', outcome: null, skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'stale claim without a session (> 10 min) → queued', run: null, claimedMinAgo: 11, items: [],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'fresh claim without a session waits', run: null, claimedMinAgo: 5, items: [],
    expectTouch: { status: 'dialing', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a run never started for 2 hours is stopped and its touch queued', run: 'ready', runCreatedMinAgo: 121, items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false, expectRunStatus: 'stopped' },
  { name: 'released touch of an exited enrollment is skipped with the exit reason', run: 'stopped', enrollment: { status: 'exited', exitReason: 'left_query' }, items: [{ status: 'pending' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'left_query', keepsRun: false }, expectEnrollment: { status: 'exited', touchesDone: 1 }, expectAdvanced: false },
];

interface Seeded { touchId: string; enrollmentId: string; sessionId: string | null }

async function one<T>(pool: pg.Pool, text: string, values: unknown[]): Promise<T> {
  const { rows } = await pool.query(text, values);
  return rows[0] as T;
}

async function seed(pool: pg.Pool, c: Case): Promise<Seeded> {
  const tag = randomUUID().slice(0, 8);
  const sfRecordId = `00Q00000${tag}00`;
  const org = await one<{ id: string }>(pool, `insert into organizations (name, slug) values ($1, $2) returning id`, [`Reconcile ${tag}`, `reconcile-${tag}`]);
  const user = await one<{ id: string }>(pool, `insert into users (org_id, email) values ($1, $2) returning id`, [org.id, `rep-${tag}@example.test`]);
  const campaign = await one<{ id: string }>(pool,
    `insert into campaigns (org_id, name, sf_object, source_kind, soql, status) values ($1, 'Spring sellers', 'Lead', 'soql', 'SELECT Id FROM Lead', 'active') returning id`, [org.id]);
  const record = await one<{ id: string }>(pool,
    `insert into crm_records (org_id, sf_object, sf_record_id, phones) values ($1, 'Lead', $2, '[{"field":"MobilePhone","e164":"+16195550100"}]') returning id`, [org.id, sfRecordId]);
  const enrollment = await one<{ id: string }>(pool,
    `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, status, exit_reason, enrolled_at) values ($1, $2, $3, $4, $5, $6) returning id`,
    [org.id, campaign.id, record.id, c.enrollment?.status ?? 'active', c.enrollment?.exitReason ?? null, minAgo(24 * 60)]);
  await pool.query(`insert into enrollment_contact_keys (enrollment_id, org_id, key, active) values ($1, $2, '+16195550100', $3)`, [enrollment.id, org.id, !c.enrollment]);
  let sessionId: string | null = null;
  if (c.run) {
    const run = await one<{ id: string }>(pool,
      `insert into dialer_sessions (org_id, user_id, sf_owner_id, object_type, status, campaign_id, created_at, updated_at) values ($1, $2, '005000000000001AAA', 'Lead', $3, $4, $5, $6) returning id`,
      [org.id, user.id, c.run, campaign.id, minAgo(c.runCreatedMinAgo ?? 30), minAgo(c.runUpdatedMinAgo ?? 1)]);
    sessionId = run.id;
    for (const [i, it] of c.items.entries()) {
      await pool.query(
        `insert into dialer_queue_items (session_id, ordinal, object_type, record_id, status, outcome, attempt) values ($1, $2, 'Lead', $3, $4, $5, $6)`,
        [sessionId, i, it.otherRecord ? OTHER_RECORD : sfRecordId, it.status, it.outcome ?? null, it.attempt ?? 1]);
    }
  }
  const touch = await one<{ id: string }>(pool,
    `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, dialer_session_id, claimed_at) values ($1, $2, 1, 'rep_call', 'dialing', $3, $4, $5) returning id`,
    [org.id, enrollment.id, minAgo(60), sessionId, minAgo(c.claimedMinAgo ?? 30)]);
  return { touchId: touch.id, enrollmentId: enrollment.id, sessionId };
}

describe.skipIf(!pgLane)('reconcileCampaignCalls (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const seeded = new Map<string, Seeded>();
  let result: { resolved: number; released: number };

  beforeAll(async () => {
    t = await createTestDb();
    for (const c of CASES) seeded.set(c.name, await seed(t.pool, c));
    result = await reconcileCampaignCalls({ db: t.db, now: NOW, log });
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('counts what it settled and what it handed back, and logs no failure', () => {
    expect(log.error).not.toHaveBeenCalled();
    const resolved = CASES.filter((c) => c.expectTouch.status === 'sent' || c.expectTouch.status === 'skipped').length;
    const released = CASES.filter((c) => c.expectTouch.status === 'queued').length;
    expect(result).toEqual({ resolved, released });
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const s = seeded.get(c.name)!;
    const touch = await one<{ status: string; outcome: string | null; skip_reason: string | null; dialer_session_id: string | null; claimed_at: Date | null; sent_at: Date | null }>(
      t.pool, `select status, outcome, skip_reason, dialer_session_id, claimed_at, sent_at from touches where id = $1`, [s.touchId]);
    expect({ status: touch.status, outcome: touch.outcome, skipReason: touch.skip_reason })
      .toEqual({ status: c.expectTouch.status, outcome: c.expectTouch.outcome, skipReason: c.expectTouch.skipReason });
    expect(touch.dialer_session_id).toBe(c.expectTouch.keepsRun ? s.sessionId : null);
    if (c.expectTouch.status === 'queued') expect(touch.claimed_at).toBeNull();
    if (c.expectTouch.status === 'sent') expect(touch.sent_at?.toISOString()).toBe(NOW.toISOString());

    const enrollment = await one<{ status: string; touches_done: number }>(
      t.pool, `select status, touches_done from campaign_enrollments where id = $1`, [s.enrollmentId]);
    expect({ status: enrollment.status, touchesDone: enrollment.touches_done }).toEqual(c.expectEnrollment);
    expect(advanced.includes(s.touchId)).toBe(c.expectAdvanced);

    if (c.expectRunStatus && s.sessionId) {
      const run = await one<{ status: string }>(t.pool, `select status from dialer_sessions where id = $1`, [s.sessionId]);
      expect(run.status).toBe(c.expectRunStatus);
    }
  });

  it('a connected enrollment keeps its contact keys active (one active campaign per person)', async () => {
    const s = seeded.get(CASES[0]!.name)!;
    const key = await one<{ active: boolean }>(t.pool, `select active from enrollment_contact_keys where enrollment_id = $1`, [s.enrollmentId]);
    expect(key.active).toBe(true);
  });

  it('a second tick changes nothing that the first settled', async () => {
    advanced.length = 0;
    const again = await reconcileCampaignCalls({ db: t.db, now: NOW, log });
    expect(again).toEqual({ resolved: 0, released: 0 });
    expect(advanced).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/campaigns/reconcile.test.ts 2>&1 | tail -8
```
Expected: `Test Files  1 failed (1)`, with `Error: Failed to load url ./reconcile.js (resolved id: ./reconcile.js) in …/src/campaigns/reconcile.test.ts. Does the file exist?`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "reconcile|Test Files|Tests "
```
Expected: both `reconcile.test.ts` and `reconcile.pg.test.ts` fail with the same `Failed to load url ./reconcile.js` error. Every other file passes.

- [ ] **Step 4: Write `reconcile.ts`**

Create `services/outreach-api/src/campaigns/reconcile.ts`. Raw `db.execute` returns `timestamptz` columns as strings under drizzle's node-postgres driver (pool `query` returns `Date`s), so every timestamp read here goes through `toDate`. Each claimed touch is settled in its own transaction and its own `try`. One bad row is logged and skipped, and it never stops the tick.
```ts
/**
 * Campaign call reconciliation (spec §10.1, plan 1B task B6) — the
 * `calls.reconcile` tick.
 *
 * A rep starts "Campaign calls" in the softphone: cti-api claims the campaign's
 * queued `rep_call` touches (status `dialing`, `claimed_at`), builds a normal
 * power-dial run over their records, and stamps the run's id on each touch
 * (`dialer_session_id`). The dialer itself never learns about touches. This
 * tick reads what the run wrote — the `dialer_queue_items` for (session,
 * record), which includes the engine's attempt-2 retry rows that carry no link
 * of their own (plan refinement 5) — and settles each claimed touch:
 *
 *  - an item reached a person (`connected`, or `done`, which only a connected
 *    item becomes once the rep presses Next / End call / Redial) → touch
 *    `sent`, outcome `connected`; the enrollment becomes `conversing` (the rep
 *    owns it now) and its contact keys stay active.
 *  - every item settled without a connect → `sent` with the last miss's
 *    outcome when any dial missed (`no_connect`), otherwise `skipped` with the
 *    first item's reason (build-time consent or flag skips, dial-time
 *    `out_of_hours`, or `unreachable`).
 *  - the record has no queue row in its run: `createDialerSession` dropped it
 *    at build. The run's rows are complete before B4 stamps the run on the
 *    touch, so the record will not be dialed in this run → `skipped`, reason
 *    `not_in_run`. (Releasing it would re-claim and re-drop it every run.)
 *    Build-time gates that DO write a row (consent, DNC, Skip on Dialer,
 *    already worked, unreachable) arrive as settled `skipped`/`unreachable`
 *    items and are handled by the rule above.
 *  - the run ended (`stopped`/`done`) before reaching the record → back to
 *    `queued` for the next run.
 *  - a run created and never started for 2 hours → stopped (only while still
 *    `ready`, compare-and-swap — the same write the softphone's "Choose a
 *    different list" makes) and its touches go back to `queued`.
 *  - a claim that never got its run (a crash between claim and build) → back
 *    to `queued` after 10 minutes.
 *
 * Settled non-connected touches advance the sequence through
 * `advanceAfterTouch`; a connected one does not — the person left the sequence
 * for a conversation. Nothing is written to Salesforce here: the dialer already
 * logs connects (call Task) and misses (Chatter) — plan refinement 7.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@cti/db';
import type { RunnerLogger } from '../jobs/boss.js';
import { advanceAfterTouch } from '../planner/run.js';

export const STALE_CLAIM_MS = 10 * 60_000;
/** A `dialing` item in a run that just ended is still waiting on Twilio's status callback. */
export const ENDED_RUN_GRACE_MS = 10 * 60_000;
export const ABANDONED_READY_MS = 2 * 60 * 60_000;
export const RECONCILE_BATCH = 1000;
/** Skip reason for a claimed record that `createDialerSession` left out of the run entirely. */
export const NOT_IN_RUN = 'not_in_run';

export type DialerItemStatus = 'pending' | 'dialing' | 'connected' | 'no_connect' | 'skipped' | 'unreachable' | 'done';
export type DialerSessionStatus = 'active' | 'paused' | 'stopped' | 'done' | 'ready';

export interface ReconcileItem { status: DialerItemStatus; outcome: string | null; attempt: number; ordinal: number }
export interface ReconcileSession { status: DialerSessionStatus; createdAt: Date; updatedAt: Date }
export interface ReconcileInput {
  /** The touch's `dialer_session_id`; null while the claim has no run yet. */
  sessionId: string | null;
  claimedAt: Date | null;
  /** Null when `sessionId` is set but the run's row is gone. */
  session: ReconcileSession | null;
  /** Every queue item of the run for this touch's record, retries included. */
  items: readonly ReconcileItem[];
  now: Date;
}
export type Resolution =
  | { kind: 'connected' }
  | { kind: 'sent'; outcome: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'release' }
  | { kind: 'abandon' }
  | { kind: 'wait' };

const CONNECTED: ReadonlySet<DialerItemStatus> = new Set(['connected', 'done']);
const LIVE: ReadonlySet<DialerItemStatus> = new Set(['pending', 'dialing']);
const ENDED: ReadonlySet<DialerSessionStatus> = new Set(['stopped', 'done']);

const ageMs = (now: Date, then: Date): number => now.getTime() - then.getTime();
const dialOrder = (a: ReconcileItem, b: ReconcileItem): number => a.attempt - b.attempt || a.ordinal - b.ordinal;

/** Every item settled without a connect: any miss makes it a sent call; only skips make it a skipped touch. */
function settle(settled: readonly ReconcileItem[]): Resolution {
  const ordered = [...settled].sort(dialOrder);
  const lastMiss = ordered.filter((i) => i.status === 'no_connect').at(-1);
  if (lastMiss) return { kind: 'sent', outcome: lastMiss.outcome ?? 'no_connect' };
  const first = ordered[0]!; // callers pass at least one settled item
  return { kind: 'skipped', reason: first.outcome ?? first.status };
}

/** Pure: what one claimed (`dialing`) campaign call touch becomes now. */
export function resolveCampaignTouch(input: ReconcileInput): Resolution {
  const { session, items, now } = input;
  if (!input.sessionId) {
    const fresh = input.claimedAt !== null && ageMs(now, input.claimedAt) < STALE_CLAIM_MS;
    return fresh ? { kind: 'wait' } : { kind: 'release' };
  }
  if (!session) return { kind: 'release' };
  // The run's rows are complete before the touch carries its id: no row means the build dropped the record.
  if (items.length === 0) return { kind: 'skipped', reason: NOT_IN_RUN };
  if (items.some((i) => CONNECTED.has(i.status))) return { kind: 'connected' };
  const live = items.filter((i) => LIVE.has(i.status));
  const settled = items.filter((i) => !LIVE.has(i.status));
  if (live.length === 0 && settled.length > 0) return settle(settled);
  if (ENDED.has(session.status)) {
    const ringing = live.some((i) => i.status === 'dialing');
    if (ringing && ageMs(now, session.updatedAt) < ENDED_RUN_GRACE_MS) return { kind: 'wait' };
    return settled.length > 0 ? settle(settled) : { kind: 'release' };
  }
  if (session.status === 'ready' && ageMs(now, session.createdAt) >= ABANDONED_READY_MS) return { kind: 'abandon' };
  return { kind: 'wait' };
}

// Raw `db.execute` rows: drizzle's node-postgres driver hands timestamps back as strings.
type Timestamp = Date | string;
interface ClaimedRow { touch_id: string; enrollment_id: string; session_id: string | null; claimed_at: Timestamp | null; sf_record_id: string }
interface SessionRow { id: string; status: DialerSessionStatus; created_at: Timestamp; updated_at: Timestamp }
interface ItemRow { session_id: string; record_id: string; status: DialerItemStatus; outcome: string | null; attempt: number; ordinal: number }
interface Runs { sessions: Map<string, ReconcileSession>; items: Map<string, ReconcileItem[]> }
type Executor = Pick<Db, 'execute'>;
type Applied = 'resolved' | 'released' | 'none';

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
const toDate = (v: Timestamp): Date => (v instanceof Date ? v : new Date(v));
const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);
const itemKey = (sessionId: string, recordId: string): string => `${sessionId}|${recordId}`;

async function loadClaimed(db: Db, batch: number): Promise<ClaimedRow[]> {
  return rowsOf<ClaimedRow>(await db.execute(sql`
    select t.id as touch_id, t.enrollment_id, t.dialer_session_id as session_id, t.claimed_at, r.sf_record_id
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id
    join crm_records r on r.id = e.crm_record_id
    where t.status = 'dialing' and t.channel = 'rep_call'
    order by t.claimed_at nulls first, t.id
    limit ${batch}`));
}

async function loadRuns(db: Db, sessionIds: readonly string[]): Promise<Runs> {
  const runs: Runs = { sessions: new Map(), items: new Map() };
  if (sessionIds.length === 0) return runs;
  const sessions = rowsOf<SessionRow>(await db.execute(sql`
    select id, status, created_at, updated_at from dialer_sessions where id in (${idList(sessionIds)})`));
  for (const s of sessions) runs.sessions.set(s.id, { status: s.status, createdAt: toDate(s.created_at), updatedAt: toDate(s.updated_at) });
  const items = rowsOf<ItemRow>(await db.execute(sql`
    select session_id, record_id, status, outcome, attempt, ordinal
    from dialer_queue_items where session_id in (${idList(sessionIds)})`));
  for (const i of items) {
    const key = itemKey(i.session_id, i.record_id);
    runs.items.set(key, [...(runs.items.get(key) ?? []), { status: i.status, outcome: i.outcome, attempt: i.attempt, ordinal: i.ordinal }]);
  }
  return runs;
}

function resolutionFor(row: ClaimedRow, runs: Runs, now: Date): Resolution {
  const session = row.session_id ? runs.sessions.get(row.session_id) ?? null : null;
  const items = row.session_id ? runs.items.get(itemKey(row.session_id, row.sf_record_id)) ?? [] : [];
  const claimedAt = row.claimed_at === null ? null : toDate(row.claimed_at);
  return resolveCampaignTouch({ sessionId: row.session_id, claimedAt, session, items, now });
}

/** A run nobody started: stop it while it is still `ready` (never once the rep has pressed Start). */
async function stopAbandonedRun(db: Db, sessionId: string, now: Date, log: RunnerLogger): Promise<boolean> {
  const stopped = rowsOf<{ id: string }>(await db.execute(sql`
    update dialer_sessions set status = 'stopped', updated_at = ${now}
    where id = ${sessionId} and status = 'ready'
    returning id`));
  if (stopped.length > 0) log.warn({ sessionId }, 'calls.reconcile: stopped a campaign run that was never started');
  return stopped.length > 0;
}

/** Count the touch without moving the sequence (its enrollment is no longer `active`). Same once-per-touch guard as advanceAfterTouch. */
async function bumpTouchesDone(tx: Executor, touchId: string, now: Date): Promise<void> {
  await tx.execute(sql`
    update campaign_enrollments e set touches_done = e.touches_done + 1, updated_at = ${now}
    from touches t
    where t.id = ${touchId} and e.id = t.enrollment_id and e.touches_done < t.seq`);
}

/** Settle a claimed touch (compare-and-swap on `dialing` + its run), then move its enrollment on. */
async function settleTouch(db: Db, row: ClaimedRow, end: Exclude<Resolution, { kind: 'release' | 'abandon' | 'wait' }>, now: Date): Promise<Applied> {
  const status = end.kind === 'skipped' ? 'skipped' : 'sent';
  const outcome = end.kind === 'connected' ? 'connected' : end.kind === 'sent' ? end.outcome : null;
  const skipReason = end.kind === 'skipped' ? end.reason : null;
  return db.transaction(async (tx) => {
    const updated = rowsOf<{ id: string }>(await tx.execute(sql`
      update touches set status = ${status}, outcome = ${outcome}, skip_reason = ${skipReason},
        sent_at = ${status === 'sent' ? now : null}, updated_at = ${now}
      where id = ${row.touch_id} and status = 'dialing' and dialer_session_id = ${row.session_id}
      returning id`));
    if (updated.length === 0) return 'none';
    const [enrollment] = rowsOf<{ status: string }>(await tx.execute(sql`
      select status from campaign_enrollments where id = ${row.enrollment_id} for update`));
    if (end.kind === 'connected') {
      // A connect is a reply (spec §10.1): the rep owns the conversation now.
      await tx.execute(sql`
        update campaign_enrollments e set
          status = case when e.status = 'active' then 'conversing' else e.status end,
          next_touch_at = case when e.status = 'active' then null else e.next_touch_at end,
          touches_done = case when e.touches_done < t.seq then e.touches_done + 1 else e.touches_done end,
          updated_at = ${now}
        from touches t
        where t.id = ${row.touch_id} and e.id = t.enrollment_id`);
    } else if (enrollment?.status === 'active') {
      await advanceAfterTouch(tx as unknown as Db, row.touch_id, now);
    } else {
      await bumpTouchesDone(tx, row.touch_id, now);
    }
    return 'resolved';
  });
}

/**
 * Hand a claimed touch back: `queued` for the next run while its enrollment is
 * still active, else `skipped` with the enrollment's exit reason (an exit while
 * the call was claimed left this touch behind — `exitEnrollment` cancels only
 * `planned|held|queued`).
 */
async function releaseTouch(db: Db, row: ClaimedRow, now: Date): Promise<Applied> {
  return db.transaction(async (tx) => {
    const [touch] = rowsOf<{ status: 'queued' | 'skipped' }>(await tx.execute(sql`
      update touches t set
        status = case when e.status = 'active' then 'queued' else 'skipped' end,
        skip_reason = case when e.status = 'active' then t.skip_reason else coalesce(e.exit_reason, e.status) end,
        dialer_session_id = null, claimed_at = null, updated_at = ${now}
      from campaign_enrollments e
      where t.id = ${row.touch_id} and e.id = t.enrollment_id and t.status = 'dialing'
        and t.dialer_session_id is not distinct from ${row.session_id}::uuid
      returning t.status`));
    if (!touch) return 'none';
    if (touch.status === 'queued') return 'released';
    await bumpTouchesDone(tx, row.touch_id, now);
    return 'resolved';
  });
}

async function apply(db: Db, row: ClaimedRow, r: Resolution, now: Date): Promise<Applied> {
  switch (r.kind) {
    case 'connected':
    case 'sent':
    case 'skipped':
      return settleTouch(db, row, r, now);
    case 'release':
      return releaseTouch(db, row, now);
    default:
      return 'none';
  }
}

export async function reconcileCampaignCalls(deps: { db: Db; now: Date; log: RunnerLogger; batch?: number }): Promise<{ resolved: number; released: number }> {
  const { db, now, log } = deps;
  const claimed = await loadClaimed(db, deps.batch ?? RECONCILE_BATCH);
  const sessionIds = [...new Set(claimed.flatMap((c) => (c.session_id ? [c.session_id] : [])))];
  const runs = await loadRuns(db, sessionIds);
  const abandoned = new Map<string, boolean>();
  const counts = { resolved: 0, released: 0 };
  for (const row of claimed) {
    try {
      let r = resolutionFor(row, runs, now);
      if (r.kind === 'abandon' && row.session_id) {
        if (!abandoned.has(row.session_id)) abandoned.set(row.session_id, await stopAbandonedRun(db, row.session_id, now, log));
        r = abandoned.get(row.session_id) ? { kind: 'release' } : { kind: 'wait' };
      }
      const applied = await apply(db, row, r, now);
      if (applied !== 'none') counts[applied] += 1;
    } catch (err) {
      log.error({ err: (err as Error).message, touchId: row.touch_id }, 'calls.reconcile: could not settle a campaign call touch');
    }
  }
  if (counts.resolved > 0 || counts.released > 0) log.info(counts, 'calls.reconcile');
  return counts;
}
```

- [ ] **Step 5: Declare the queue and its schedule**

In `services/outreach-api/src/jobs/queues.ts`, add this as the last `QUEUES` entry, after B2's `'sf.write'` line:
```ts
  { name: 'calls.reconcile', options: TICK_QUEUE_OPTIONS },
```
In `services/outreach-api/src/jobs/schedules.ts`, add this as the last `SCHEDULES` entry, after `'sf.write'`:
```ts
  { queue: 'calls.reconcile', cron: '* * * * *' },
```
In `services/outreach-api/src/jobs/schedules.test.ts`, A8's test "schedules refresh every 5 minutes and triage and planning every minute" pins the exact list. B2 extended it with `sf.write`. Add the new entry as the last element of its `toEqual([...])` array:
```ts
      { queue: 'calls.reconcile', cron: '* * * * *' },
```

- [ ] **Step 6: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/campaigns/reconcile.test.ts src/jobs 2>&1 | tail -5
```
Expected: no failures. `reconcile.test.ts` reports 31 tests (29 decisions and 2 wiring checks).
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "reconcile|Test Files|Tests "
```
Expected: `✓ src/campaigns/reconcile.pg.test.ts (19 tests)` and `✓ src/campaigns/reconcile.test.ts (31 tests)`. The suite's `Test Files` line shows no failures.

- [ ] **Step 7: Wire the handler in `server.ts`**

Add the import next to the other `./campaigns/…` imports:
```ts
import { reconcileCampaignCalls } from './campaigns/reconcile.js';
```
In `main()`'s `handlers` object, add this entry after A10's `'touch.plan'` entry and B2's `'sf.write'` entry. It is unconditional because it needs neither Salesforce nor AI: it only reads the dialer's tables and writes ours.
```ts
    // Settle claimed campaign call touches from the dialer runs that carried them (src/campaigns/reconcile.ts).
    'calls.reconcile': async () => {
      await reconcileCampaignCalls({ db, now: new Date(), log: console });
    },
```
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```
Expected: the typecheck is clean, and the suite passes with the `pgLane` suites skipped.

- [ ] **Step 8: Commit**
```bash
git add services/outreach-api/src/campaigns/reconcile.ts services/outreach-api/src/campaigns/reconcile.test.ts services/outreach-api/src/campaigns/reconcile.pg.test.ts services/outreach-api/src/jobs/queues.ts services/outreach-api/src/jobs/schedules.ts services/outreach-api/src/jobs/schedules.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): calls.reconcile settles campaign call touches from dialer runs"
```

---

### Task B7: Kill switch, automatic pause alerts, AI-budget resume, `GET /status`, banner

`OUTREACH_KILL_SWITCH` (`on|off`, default `off`) is one switch that stops outreach from reaching anyone. Both services read the same variable:
- **outreach-api:** `promoteQueuedCalls` queues nothing, and the Salesforce write outbox holds its rows.
- **cti-api:** the Campaign calls picker lists nothing, and a start claims nothing.

Planning, refresh, triage and reconcile keep running, so the plan stays current and a run in progress still settles. The app shows a banner.

Automatic pauses (A8's `crm_broken`, A9's `ai_budget`) now alert exactly once per pause. `ai_budget` pauses end on their own: each `touch.plan` tick first resumes every `ai_budget`-paused campaign whose tenant is under its budget for the current UTC day. In practice that happens at 00:00 UTC, or earlier when an admin raises the budget. Each campaign goes back to its `paused_from` (a dry-run campaign is never made live), and `paused_from` and `pause_reason` are cleared. `crm_broken` pauses never resume on their own.

The task has five parts, each with its own commit:
1. kill switch, outreach-api
2. kill switch, cti-api
3. pause alerts and the AI-budget resume
4. `GET /status`
5. the banner

**Files:**
- outreach-api (`services/outreach-api/`):
  - Modify `src/config.ts` (one key at the end of `schema`) and `src/config.test.ts` (append).
  - Modify A10's `src/planner/run.ts`: `PlanDeps`, `promoteQueuedCalls` and `planTick`.
  - Modify B2's `src/crm/outbox.ts`: `DrainDeps` and `drainOutbox`.
  - Create `src/kill-switch.test.ts` and `src/kill-switch.pg.test.ts`.
  - Modify `src/alerts.ts`: one `kind` member, plus `OrgAlert` and `campaignsPausedAlert` appended, in the shape B2's `sfWriteAlert` uses. Create `src/alerts.test.ts`.
  - Replace A8's `src/campaigns/pause.ts`, keeping all its exports. Create `src/campaigns/pause.test.ts`, `src/campaigns/pause.pg.test.ts` and `src/campaigns/pause-alerts.pg.test.ts`.
  - Modify A8's `src/campaigns/refresh.ts`: `RefreshDeps`, `pauseForBrokenCrm` and its two call sites.
  - Modify A9's `src/triage/run.ts`: `TriageDeps` and `pauseForBudget`.
  - Create `src/routes/status.ts` and `src/routes/status.test.ts`.
  - Modify `src/server.ts`: imports, the start of `main()`, the `campaign.refresh`, `record.triage`, `touch.plan` and `sf.write` handlers, and `apiRoutes`.
- contracts:
  - Create `packages/contracts/src/status.ts` and `packages/contracts/src/status.test.ts`.
  - Modify `packages/contracts/src/index.ts`: one export line.
- cti-api (`services/cti-api/`):
  - Modify `src/config.ts`: insert after line 183, `DIALER_TIME_TASKS`.
  - Modify `src/config.test.ts`: append after line 103, the end of the file.
  - Modify B4's `src/dialer/campaign-calls.ts`: `dueCampaignCalls`, `StartCampaignCallsDeps` and `startCampaignCalls`.
  - Modify B4's two routes in `src/routes/dialer.ts`.
  - Create `src/dialer/campaign-calls.kill-switch.test.ts`.
- outreach-web (`apps/outreach-web/`):
  - Modify `src/lib/outreach-api.ts` (A12): the contracts import, `outreachKeys` and one new function.
  - Modify `src/lib/outreach-words.ts` (A12): the `ai_budget` row and one new constant.
  - Modify `src/lib/outreach-words.test.ts` and `src/components/campaign-detail.test.tsx` (A12/A13): the `ai_budget` row in each.
  - Modify `src/components/app-shell.tsx`: one import and `<main>`.
  - Create `src/components/kill-switch-banner.tsx` and `src/components/kill-switch-banner.test.tsx`.

No migration: `campaigns.paused_from` comes from A3/A8 (A8 Skeleton correction 1).

**Interfaces:**
- **Consumes:**
  - A3: `schema.campaigns` (`status`, `pauseReason`, `pausedFrom: 'dry_run' | 'active' | null`, `updatedAt`), `schema.organizations.settings`, `schema.aiUsageDays`, `schema.touches`, `schema.crmRecords`, `schema.campaignEnrollments`.
  - A8:
    - `pause.ts`: `AutoPauseReason`, `RUNNING_CAMPAIGN_STATUSES`, and `pauseOrgCampaigns(db, orgId, reason): Promise<number>`, which sets `paused_from = status`.
    - `refresh.ts`: `type RefreshDeps`, `pauseForBrokenCrm(db, log, orgId, err)`, `refreshDueCampaigns(deps: RefreshDeps)`.
    - `RunnerLogger`, plus the `handlers` object in `server.ts`.
  - A9:
    - `TriageDeps`, `pauseForBudget(deps, orgId, spent, budget)`, `triageDueRecords(deps)`.
    - `spentTodayMicros(db, orgId, now)` and `budgetMicros(settings)` from `src/ai/budget.ts`.
    - `TriageModel` from `src/ai/model.ts`.
  - A10: `outreachSettings(org)`, `PlanDeps`, `promoteQueuedCalls(db, now)`, and `planTick(deps)` (plan, then promote).
  - A5:
    - `CrmNotConnectedError` and `SalesforceClientFactory` from `src/crm/client-factory.ts`.
    - `cfg.salesforceEnabled`.
  - B2:
    - `DrainDeps`, `drainOutbox(deps): Promise<{ done; failed }>`, `outboxJob(deps)`.
    - `sfWriteAlert` (B2 already alerts `sf_write_failing` once per row after 24 h).
  - B4: `dueCampaignCalls(db, orgId, now)`, `StartCampaignCallsDeps { db; now; build }`, `startCampaignCalls(deps, args)` returning `{ kind: 'started' | 'nothing_due' | 'build_failed' }`, and the two routes.
  - Shared: `requireContext` from `src/tenancy/scope.ts`; `buildApp`, `fakeDb` and `testConfig` from the test harness.
  - outreach-web (A12): `api(path, schema)`, `outreachKeys`, `PAUSE_REASON_WORDS`, `pauseReasonWords`, `renderWithProviders`, `stubApi` and `respond`.
- **Produces:**
  - outreach-api `AppConfig.OUTREACH_KILL_SWITCH: 'on' | 'off'`, and the same key on cti-api's `AppConfig`.
  - Kill-switch parameters:
    - `promoteQueuedCalls(db, now, opts?: { killSwitch?: boolean })`
    - `PlanDeps.killSwitch?: boolean`
    - `DrainDeps.killSwitch?: boolean`
    - `dueCampaignCalls(db, orgId, now, opts?: { killSwitch?: boolean })`
    - `StartCampaignCallsDeps.killSwitch?: boolean`
  - `alerts.ts`:
    - the kind `'campaigns_paused'`
    - `type OrgAlert = (orgId: string, message: string) => Promise<void>`, the shape of B2's `sfWriteAlert` and of `DrainDeps.alert`
    - `campaignsPausedAlert(logger): OrgAlert`
  - `pause.ts`:
    - `pauseAlertText(reason, paused: ReadonlyArray<{ id; name }>): string`
    - `pauseOrgCampaigns(db, orgId, reason, alert?: OrgAlert): Promise<number>`
    - `resumeBudgetPausedCampaigns(deps: { db; now; log }): Promise<number>`
  - `RefreshDeps.alert?: OrgAlert` and `TriageDeps.alert?: OrgAlert`.
  - Contracts: `OutreachStatus = z.object({ killSwitch: z.boolean() })`.
  - `registerStatusRoutes(app, { db, cfg })` serves `GET /api/status` → `OutreachStatus`. It requires a session.
  - outreach-web:
    - `getStatus()` and `outreachKeys.status`
    - `KILL_SWITCH_WORDS`
    - `KillSwitchBanner`, rendered by `AppShell` above every signed-in page

#### Part 1: the kill switch in outreach-api

- [ ] **Step 1: Write the failing tests**

Append to `services/outreach-api/src/config.test.ts`:
```ts

describe('OUTREACH_KILL_SWITCH', () => {
  it('defaults to off, and an empty value (a deploy UI\'s placeholder) is off too', () => {
    expect(parseConfig(base).OUTREACH_KILL_SWITCH).toBe('off');
    expect(parseConfig({ ...base, OUTREACH_KILL_SWITCH: '' }).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('on turns it on', () => {
    expect(parseConfig({ ...base, OUTREACH_KILL_SWITCH: 'on' }).OUTREACH_KILL_SWITCH).toBe('on');
  });
  it('anything else fails the boot rather than guessing what "true" or "1" meant', () => {
    expect(() => parseConfig({ ...base, OUTREACH_KILL_SWITCH: 'true' })).toThrow(/OUTREACH_KILL_SWITCH/);
  });
});
```

Create `services/outreach-api/src/kill-switch.test.ts`:
```ts
/**
 * OUTREACH_KILL_SWITCH (plan 1B task B7) in outreach-api, without a database:
 * with the switch on, promotion and the Salesforce outbox return before they
 * touch the database or build a Salesforce client. The database half is in
 * kill-switch.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import type { SalesforceClientFactory } from './crm/client-factory.js';
import { drainOutbox } from './crm/outbox.js';
import { promoteQueuedCalls } from './planner/run.js';

const untouchable = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`the kill switch must not touch the database (read db.${String(prop)})`);
  },
}) as unknown as Db;
const NOW = new Date('2026-10-05T18:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('OUTREACH_KILL_SWITCH=on', () => {
  it('promoteQueuedCalls queues no campaign call', async () => {
    await expect(promoteQueuedCalls(untouchable, NOW, { killSwitch: true })).resolves.toBe(0);
  });

  it('drainOutbox sends nothing: no outbox read, no Salesforce client, no alert', async () => {
    const clients = vi.fn<SalesforceClientFactory>(async () => { throw new Error('no client while switched off'); });
    const alert = vi.fn(async () => {});
    await expect(drainOutbox({ db: untouchable, clients, now: NOW, log, alert, killSwitch: true })).resolves.toEqual({ done: 0, failed: 0 });
    expect(clients).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
```

Create `services/outreach-api/src/kill-switch.pg.test.ts`. The enrollment's `next_touch_at` is a day ahead, so the planner leaves it alone and only promotion acts on its touch:
```ts
/**
 * OUTREACH_KILL_SWITCH against real Postgres (plan 1B task B7): a planned
 * campaign call that is due stays `planned` while the switch is on — through
 * the `touch.plan` tick and through promoteQueuedCalls itself — and is queued
 * for the dialer on the first tick after it is turned off. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { planTick, promoteQueuedCalls } from './planner/run.js';
import { createTestDb, pgLane, type TestDb } from './test/pg.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const DAY_MS = 86_400_000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(!pgLane)('kill switch and campaign call promotion (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('queues nothing while on, and the same touch once off', async () => {
    const slug = `kill-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Kill ${slug}`, slug }).returning();
    const orgId = org!.id;
    const [campaign] = await t.db.insert(schema.campaigns)
      .values({ orgId, name: 'Spring sellers', sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead', status: 'active' }).returning();
    const [record] = await t.db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q0000${randomBytes(4).toString('hex')}AAA` }).returning();
    const [enrollment] = await t.db.insert(schema.campaignEnrollments)
      .values({ orgId, campaignId: campaign!.id, crmRecordId: record!.id, nextTouchAt: new Date(NOW.getTime() + DAY_MS) }).returning();
    const [touch] = await t.db.insert(schema.touches)
      .values({ orgId, enrollmentId: enrollment!.id, seq: 1, channel: 'rep_call', status: 'planned', dueAt: new Date(NOW.getTime() - 60_000) }).returning();
    const statusOf = async () => (await t.db.select({ status: schema.touches.status }).from(schema.touches).where(eq(schema.touches.id, touch!.id)))[0]?.status;

    expect((await planTick({ db: t.db, now: NOW, log, killSwitch: true })).promoted).toBe(0);
    expect(await statusOf()).toBe('planned');
    expect(await promoteQueuedCalls(t.db, NOW, { killSwitch: true })).toBe(0);
    expect(await statusOf()).toBe('planned');

    expect((await planTick({ db: t.db, now: NOW, log })).promoted).toBeGreaterThanOrEqual(1);
    expect(await statusOf()).toBe('queued');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts src/kill-switch.test.ts 2>&1 | tail -15
```
Expected failures:
- In `config.test.ts`, 3 tests fail: `expected undefined to be 'off'`, `expected undefined to be 'on'`, and `expected [Function] to throw an error`.
- In `kill-switch.test.ts`, both tests fail. The switch is not there yet, so each function reads the proxy and rejects with `the kill switch must not touch the database (read db.execute)` (for the outbox, the read named is whatever B2's store touches first).
- `npm -w services/outreach-api run typecheck` reports `'killSwitch' does not exist in type` errors for the new arguments.

- [ ] **Step 3: Implement**

In `services/outreach-api/src/config.ts`, add this as the last key of the `schema` object:
```ts
  /**
   * Global kill switch for outreach sends (spec §12). `on` = no campaign call is
   * promoted to the dialer's queue, cti-api claims none (it reads the same
   * variable), and the Salesforce write outbox holds its rows; the app shows a
   * banner. Planning, triage, refresh, and reconcile keep running. Default
   * `off`. A strict enum like cti-api's switches: `true` / `1` fail the boot
   * instead of being read as "off".
   */
  OUTREACH_KILL_SWITCH: z.enum(['on', 'off']).default('off'),
```

In A10's `services/outreach-api/src/planner/run.ts`, add this as the last member of `export interface PlanDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: plan as usual, but queue nothing for the dialer. */
  killSwitch?: boolean;
```
Replace the first two lines of `promoteQueuedCalls`:
```ts
/** In ACTIVE campaigns, due `planned` rep calls join the call queue. Dry-run touches stay `planned`. */
export async function promoteQueuedCalls(db: Db, now: Date): Promise<number> {
```
with:
```ts
/**
 * In ACTIVE campaigns, due `planned` rep calls join the call queue. Dry-run touches stay `planned`.
 * With OUTREACH_KILL_SWITCH on, nothing is queued: due touches stay `planned` and are queued
 * on the first tick after the switch is turned off.
 */
export async function promoteQueuedCalls(db: Db, now: Date, opts: { killSwitch?: boolean } = {}): Promise<number> {
  if (opts.killSwitch) return 0;
```
In `planTick`, change:
```ts
  const promoted = await promoteQueuedCalls(deps.db, deps.now);
```
to:
```ts
  const promoted = await promoteQueuedCalls(deps.db, deps.now, { killSwitch: deps.killSwitch });
```
The gate lives in `promoteQueuedCalls`, the function the skeleton names. `planTick` only passes it through, so planning keeps running while the switch is on.

In B2's `services/outreach-api/src/crm/outbox.ts`, add this as the last member of `export interface DrainDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: hold every row (nothing is lost; they send after it is turned off). */
  killSwitch?: boolean;
```
Make this the first statement of `drainOutbox`:
```ts
  if (deps.killSwitch) return { done: 0, failed: 0 };
```
`outboxJob(deps: Omit<DrainDeps, 'now'>)` passes `killSwitch` through unchanged.

In `services/outreach-api/src/server.ts`, insert directly after `const db = getDb();` in `main()`:
```ts
  // OUTREACH_KILL_SWITCH (plan 1B B7): no campaign call reaches the dialer's queue and no
  // Salesforce write is sent. cti-api reads the same variable for its half.
  const killSwitch = cfg.OUTREACH_KILL_SWITCH === 'on';
  if (killSwitch) console.warn('[outreach] OUTREACH_KILL_SWITCH is on: campaign calls are not queued and Salesforce writes are held');
```
In the `'touch.plan'` handler, change `await planTick({ db, now: new Date(), log: console });` to:
```ts
        await planTick({ db, now: new Date(), log: console, killSwitch });
```
In the `'sf.write'` handler, add `killSwitch` to the object B2 passes to `outboxJob`. With B2's entry as drafted, it becomes:
```ts
    'sf.write': outboxJob({ db, clients, log: console, alert: sfWriteAlert(console), killSwitch }),
```

- [ ] **Step 4: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test -- src/config.test.ts src/kill-switch.test.ts 2>&1 | tail -5
```
Expected: the typecheck is clean and there are no failures. `kill-switch.test.ts` passes 2 tests.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "kill-switch|planner/run|Test Files|Tests "
```
Expected: `✓ src/kill-switch.pg.test.ts (1 test)`. A10's `planner/run.test.ts` still passes, because `promoteQueuedCalls(db, now)` without `opts` behaves exactly as before.

- [ ] **Step 5: Commit**
```bash
git add services/outreach-api/src/config.ts services/outreach-api/src/config.test.ts services/outreach-api/src/planner/run.ts services/outreach-api/src/crm/outbox.ts services/outreach-api/src/kill-switch.test.ts services/outreach-api/src/kill-switch.pg.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): OUTREACH_KILL_SWITCH holds campaign calls and Salesforce writes"
```

#### Part 2: the kill switch in cti-api

cti-api is live and edited by another session. Keep this diff to the lines below.

- [ ] **Step 6: Write the failing tests**

Append to `services/cti-api/src/config.test.ts`, after line 103:
```ts

describe('OUTREACH_KILL_SWITCH — outreach campaign calls (plan 1B)', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OUTREACH_KILL_SWITCH; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to OFF', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: undefined })).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('an empty value is treated as unset → off', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: '' })).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('on turns it on', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: 'on' })).OUTREACH_KILL_SWITCH).toBe('on');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ OUTREACH_KILL_SWITCH: 'true' })).rejects.toThrow(/OUTREACH_KILL_SWITCH/);
  });
});
```

Create `services/cti-api/src/dialer/campaign-calls.kill-switch.test.ts`:
```ts
/**
 * OUTREACH_KILL_SWITCH in cti-api (outreach plan 1B task B7): with the switch
 * on, the Campaign calls picker lists nothing and a start claims nothing —
 * neither reads the database or builds a run. With it off (B4's own tests),
 * both behave as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { dueCampaignCalls, startCampaignCalls } from './campaign-calls.js';

type Executor = Parameters<typeof dueCampaignCalls>[0];
const untouchable = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`the kill switch must not touch the database (read db.${String(prop)})`);
  },
}) as unknown as Executor;
const NOW = new Date('2026-10-05T18:00:00Z');
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';

describe('OUTREACH_KILL_SWITCH=on', () => {
  it('dueCampaignCalls lists no campaign', async () => {
    await expect(dueCampaignCalls(untouchable, 'O1', NOW, { killSwitch: true })).resolves.toEqual({ campaigns: [] });
  });

  it('startCampaignCalls claims nothing and builds no run', async () => {
    const build = vi.fn(async () => ({ sessionId: 'S1', total: 1 }));
    await expect(startCampaignCalls({ db: untouchable, now: NOW, build, killSwitch: true }, { orgId: 'O1', campaignId: CAMPAIGN_ID }))
      .resolves.toEqual({ kind: 'nothing_due' });
    expect(build).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/config.test.ts src/dialer/campaign-calls.kill-switch.test.ts 2>&1 | tail -12
```
Expected failures:
- In `config.test.ts`, 3 of the new tests fail: `expected undefined to be 'off'` twice, and `expected undefined to be 'on'`. The fourth test fails because the promise resolved instead of rejecting.
- In the kill-switch file, both tests reject with `the kill switch must not touch the database (read db.execute)`.

- [ ] **Step 8: Implement**

In `services/cti-api/src/config.ts`, after line 183 (`  DIALER_TIME_TASKS: z.enum(['on', 'off']).default('on'),`), insert:
```ts

  /**
   * Outreach's global kill switch (outreach plan 1B, spec §12) — the SAME
   * variable outreach-api reads. `on` = GET /dialer/campaigns lists nothing and
   * POST /dialer/sessions/from-campaign claims nothing (404), so no campaign
   * touch reaches a power-dial run. The rep's own list-view runs are
   * untouched. Default `off`; strict enum like NO_ANSWER_CHATTER.
   */
  OUTREACH_KILL_SWITCH: z.enum(['on', 'off']).default('off'),
```

In B4's `services/cti-api/src/dialer/campaign-calls.ts`, give `dueCampaignCalls` a fourth parameter and an early return. Its body otherwise stays as B4 wrote it:
```ts
export async function dueCampaignCalls(
  db: SqlExecutor,
  orgId: string,
  now: Date,
  opts: { killSwitch?: boolean } = {},
): Promise<CampaignCallsResponse> {
  // OUTREACH_KILL_SWITCH: the Campaign calls picker lists nothing.
  if (opts.killSwitch) return { campaigns: [] };
  return { campaigns: await dueCampaignCallRows(db, orgId, now) };
}
```
Add this as the last member of `export interface StartCampaignCallsDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: claim nothing (the route answers 404, as for "nothing due"). */
  killSwitch?: boolean;
```
Make this the first statement of `startCampaignCalls`, before `claimCampaignTouches`:
```ts
  if (deps.killSwitch) return { kind: 'nothing_due' };
```

In `services/cti-api/src/routes/dialer.ts`, `registerDialerRoutes` already has `const cfg = loadConfig();` (line 297). In B4's `GET /dialer/campaigns` handler, change:
```ts
    return dueCampaignCalls(getDb(), authed.orgId, new Date());
```
to:
```ts
    return dueCampaignCalls(getDb(), authed.orgId, new Date(), { killSwitch: cfg.OUTREACH_KILL_SWITCH === 'on' });
```
In B4's `POST /dialer/sessions/from-campaign` handler, add this line to the deps object passed to `startCampaignCalls`, right after its `now:` line:
```ts
        killSwitch: cfg.OUTREACH_KILL_SWITCH === 'on',
```

- [ ] **Step 9: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -5
```
Expected: the typecheck is clean, and the whole cti-api suite passes. That includes the 4 new config tests, the 2 kill-switch tests, and B4's route tests, which run with the switch off by default.

- [ ] **Step 10: Commit**
```bash
git add services/cti-api/src/config.ts services/cti-api/src/config.test.ts services/cti-api/src/dialer/campaign-calls.ts services/cti-api/src/dialer/campaign-calls.kill-switch.test.ts services/cti-api/src/routes/dialer.ts
git commit -m "feat(cti-api): OUTREACH_KILL_SWITCH hides and refuses campaign calls"
```

#### Part 3: one alert per automatic pause, and the AI-budget resume

- [ ] **Step 11: Write the failing tests**

Create `services/outreach-api/src/alerts.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { campaignsPausedAlert } from './alerts.js';

describe('campaignsPausedAlert', () => {
  it('logs a campaigns_paused warning for the tenant and never throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(campaignsPausedAlert(logger)('O1', 'Paused 1 campaign')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ alert: 'campaigns_paused', orgId: 'O1' }, 'alert: Paused 1 campaign');
  });
});
```

Create `services/outreach-api/src/campaigns/pause.test.ts`:
```ts
/** The one alert line an automatic pause sends (plan 1B task B7) — pure. */
import { describe, expect, it } from 'vitest';
import { pauseAlertText } from './pause.js';

describe('pauseAlertText', () => {
  it('a broken Salesforce connection asks for action, names the campaigns, and says how to recover', () => {
    expect(pauseAlertText('crm_broken', [{ id: 'C1', name: 'Spring sellers' }, { id: 'C2', name: 'Probate' }])).toBe(
      'Action needed: paused 2 campaigns (Spring sellers, Probate) because the Salesforce connection is broken. Reconnect it in Settings → Connections, then resume each campaign.',
    );
  });

  it('a spent AI budget says when the campaigns resume', () => {
    expect(pauseAlertText('ai_budget', [{ id: 'C1', name: 'Spring sellers' }])).toBe(
      "Paused 1 campaign (Spring sellers) because today's AI budget is used up. Paused campaigns resume on their own at 00:00 UTC.",
    );
  });
});
```

Create `services/outreach-api/src/campaigns/pause.pg.test.ts`. The tests share one database, so they assert on each tenant's own rows, not on global counts:
```ts
/**
 * Automatic pauses against real Postgres (plan 1B task B7): one alert per
 * pause, `paused_from` kept, and the AI-budget resume — next UTC day yes,
 * Salesforce-broken pauses never. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import type { OrgAlert } from '../alerts.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { pauseOrgCampaigns, resumeBudgetPausedCampaigns } from './pause.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const PAUSE_DAY = new Date('2026-10-05T22:30:00Z');
const SAME_DAY = new Date('2026-10-05T23:59:00Z');
const NEXT_DAY = new Date('2026-10-06T00:01:00Z');

describe.skipIf(!pgLane)('automatic campaign pauses (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  async function tenant(statuses: Array<'draft' | 'dry_run' | 'active'>) {
    const slug = `pause-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Pause ${slug}`, slug }).returning();
    const rows = await t.db
      .insert(schema.campaigns)
      .values(statuses.map((status, i) => ({ orgId: org!.id, name: `C${i} ${status}`, sfObject: 'Lead' as const, sourceKind: 'soql' as const, soql: 'SELECT Id FROM Lead', status })))
      .returning();
    return { orgId: org!.id, ids: rows.map((r) => r.id) };
  }
  const campaignsOf = (ids: string[]) =>
    t.db.select({ id: schema.campaigns.id, status: schema.campaigns.status, pauseReason: schema.campaigns.pauseReason, pausedFrom: schema.campaigns.pausedFrom })
      .from(schema.campaigns).where(inArray(schema.campaigns.id, ids));

  it.each(['crm_broken', 'ai_budget'] as const)('a %s pause alerts exactly once, however many ticks hit it', async (reason) => {
    const { orgId, ids } = await tenant(['dry_run', 'active', 'draft']);
    const alert = vi.fn<OrgAlert>(async () => {});
    expect(await pauseOrgCampaigns(t.db, orgId, reason, alert)).toBe(2);
    expect(await pauseOrgCampaigns(t.db, orgId, reason, alert)).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);
    const [alertedOrg, text] = alert.mock.calls[0]!;
    expect(alertedOrg).toBe(orgId);
    expect(text).toContain(reason === 'crm_broken' ? 'the Salesforce connection is broken' : "today's AI budget is used up");
    expect(text).toContain('C0 dry_run');
    expect(text).toContain('C1 active');
    expect(text).not.toContain('C2 draft');
    const rows = new Map((await campaignsOf(ids)).map((r) => [r.id, r]));
    expect(rows.get(ids[0]!)).toMatchObject({ status: 'paused', pauseReason: reason, pausedFrom: 'dry_run' });
    expect(rows.get(ids[1]!)).toMatchObject({ status: 'paused', pauseReason: reason, pausedFrom: 'active' });
    expect(rows.get(ids[2]!)).toMatchObject({ status: 'draft', pauseReason: null });
  });

  it('pauses without alerting when no alerter is passed (1A callers)', async () => {
    const { orgId } = await tenant(['active']);
    expect(await pauseOrgCampaigns(t.db, orgId, 'crm_broken')).toBe(1);
  });

  it('ai_budget campaigns resume to their own state at the next UTC day; crm_broken ones do not', async () => {
    const budget = await tenant(['dry_run', 'active']);
    const broken = await tenant(['active']);
    await pauseOrgCampaigns(t.db, budget.orgId, 'ai_budget');
    await pauseOrgCampaigns(t.db, broken.orgId, 'crm_broken');
    // Today's spend is over the $25 default.
    await t.db.insert(schema.aiUsageDays).values({ orgId: budget.orgId, day: '2026-10-05', costMicros: 26_000_000 });

    // Other tests in this file share the database: assert on this tenant's rows, not on the returned count.
    await resumeBudgetPausedCampaigns({ db: t.db, now: SAME_DAY, log });
    expect((await campaignsOf(budget.ids)).every((c) => c.status === 'paused')).toBe(true);

    expect(await resumeBudgetPausedCampaigns({ db: t.db, now: NEXT_DAY, log })).toBeGreaterThanOrEqual(2);
    const resumed = new Map((await campaignsOf(budget.ids)).map((r) => [r.id, r]));
    expect(resumed.get(budget.ids[0]!)).toMatchObject({ status: 'dry_run', pauseReason: null, pausedFrom: null });
    expect(resumed.get(budget.ids[1]!)).toMatchObject({ status: 'active', pauseReason: null, pausedFrom: null });
    expect(await campaignsOf(broken.ids)).toEqual([expect.objectContaining({ status: 'paused', pauseReason: 'crm_broken' })]);
  });

  it('a raised budget resumes the same day; a manual pause never auto-resumes', async () => {
    const { orgId, ids } = await tenant(['active']);
    await pauseOrgCampaigns(t.db, orgId, 'ai_budget');
    await t.db.insert(schema.aiUsageDays).values({ orgId, day: '2026-10-05', costMicros: 26_000_000 });
    await t.db.update(schema.organizations).set({ settings: { aiDailyBudgetUsd: 50 } }).where(eq(schema.organizations.id, orgId));
    const manual = await tenant(['active']);
    await t.db.update(schema.campaigns).set({ status: 'paused', pauseReason: 'manual' }).where(eq(schema.campaigns.orgId, manual.orgId));

    await resumeBudgetPausedCampaigns({ db: t.db, now: PAUSE_DAY, log });
    expect(await campaignsOf(ids)).toEqual([expect.objectContaining({ status: 'active', pauseReason: null })]);
    expect(await campaignsOf(manual.ids)).toEqual([expect.objectContaining({ status: 'paused', pauseReason: 'manual' })]);
  });
});
```

Create `services/outreach-api/src/campaigns/pause-alerts.pg.test.ts`. It pins the call sites: each tick that pauses campaigns passes its alerter through, and a second tick stays quiet:
```ts
/**
 * The two ticks that pause campaigns alert exactly once per pause (plan 1B
 * task B7): campaign.refresh on an unusable Salesforce connection, and
 * record.triage on a spent AI budget. Each tick runs twice; the second finds
 * nothing running and stays quiet. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { schema } from '@cti/db';
import type { TriageModel } from '../ai/model.js';
import type { OrgAlert } from '../alerts.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { triageDueRecords } from '../triage/run.js';
import { refreshDueCampaigns } from './refresh.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const notConnected: SalesforceClientFactory = async () => { throw new CrmNotConnectedError(); };
const unusedModel: TriageModel = { triage: async () => { throw new Error('the budget check runs before the model'); } };

describe.skipIf(!pgLane)('automatic pause alerts from the ticks (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  /** A tenant with a dry-run and a live campaign, and one record waiting for triage in the live one. */
  async function tenant(): Promise<string> {
    const slug = `alerts-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Alerts ${slug}`, slug }).returning();
    const orgId = org!.id;
    const [, live] = await t.db
      .insert(schema.campaigns)
      .values((['dry_run', 'active'] as const).map((status) => ({ orgId, name: `Spring ${status}`, sfObject: 'Lead' as const, sourceKind: 'soql' as const, soql: 'SELECT Id FROM Lead', status })))
      .returning();
    const [record] = await t.db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q0000${randomBytes(4).toString('hex')}AAA` }).returning();
    await t.db.insert(schema.campaignEnrollments).values({ orgId, campaignId: live!.id, crmRecordId: record!.id });
    return orgId;
  }

  /** The alert lines sent for one tenant (other tests' tenants share the database). */
  const sentTo = (alert: Mock<OrgAlert>, orgId: string): string[] =>
    alert.mock.calls.filter(([alertedOrg]) => alertedOrg === orgId).map(([, text]) => text);

  it('campaign.refresh: an unusable Salesforce connection pauses the tenant once and alerts once', async () => {
    const orgId = await tenant();
    const alert = vi.fn<OrgAlert>(async () => {});
    for (let tick = 0; tick < 2; tick += 1) await refreshDueCampaigns({ db: t.db, clients: notConnected, now: NOW, log, alert });
    const lines = sentTo(alert, orgId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Action needed: paused 2 campaigns \(.*\) because the Salesforce connection is broken\./);
  });

  it('record.triage: a spent AI budget pauses the tenant once and alerts once', async () => {
    const orgId = await tenant();
    await t.db.insert(schema.aiUsageDays).values({ orgId, day: '2026-10-05', costMicros: 30_000_000 });
    const alert = vi.fn<OrgAlert>(async () => {});
    for (let tick = 0; tick < 2; tick += 1) {
      await triageDueRecords({ db: t.db, clients: notConnected, model: unusedModel, now: NOW, log, alert });
    }
    const lines = sentTo(alert, orgId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Paused 2 campaigns \(.*\) because today's AI budget is used up\./);
  });
});
```

- [ ] **Step 12: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/alerts.test.ts src/campaigns/pause.test.ts 2>&1 | tail -12
```
Expected failures:
- `alerts.test.ts`: `TypeError: … campaignsPausedAlert is not a function`.
- `pause.test.ts`: `TypeError: … pauseAlertText is not a function`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "pause|Test Files|Tests "
```
Expected failures:
- `pause.pg.test.ts`: the two `alerts exactly once` cases fail with `expected "spy" to be called 1 times, but got 0 times`. The resume cases fail with `TypeError: … resumeBudgetPausedCampaigns is not a function`.
- `pause-alerts.pg.test.ts`: both cases fail with `expected [] to have a length of 1 but got +0`.

- [ ] **Step 13: Implement**

In `services/outreach-api/src/alerts.ts`, add this as the last member of `AlertEvent['kind']`, after B2's `| 'sf_write_failing'`:
```ts
    /** A tenant's running campaigns were paused automatically (crm_broken, ai_budget). One alert per pause. */
    | 'campaigns_paused';
```
Move the `;` that ended B2's `| 'sf_write_failing';` line so it ends the new last member instead. Then append to the end of the file:
```ts

/**
 * What a tick takes to alert about one tenant: the shape of `DrainDeps.alert`
 * and of `sfWriteAlert`'s result (B2). Must not throw — dispatchAlert never does.
 */
export type OrgAlert = (orgId: string, message: string) => Promise<void>;

/**
 * Automatic campaign pauses (src/campaigns/pause.ts), as a warning through the
 * same log + webhook path as every other alert. A broken Salesforce connection
 * says "Action needed:" in the message itself.
 */
export function campaignsPausedAlert(logger: AlertLogger): OrgAlert {
  return (orgId, message) => dispatchAlert(logger, { kind: 'campaigns_paused', severity: 'warning', orgId, message });
}
```

Replace all of `services/outreach-api/src/campaigns/pause.ts`. A8's exports stay, with the same names and behavior. `pauseOrgCampaigns` gains an optional fourth parameter, so A8's and A9's existing calls still compile:
```ts
/**
 * Automatic campaign pauses (spec §6.4, §12). The system pauses every running
 * (`dry_run` or `active`) campaign of a tenant when its Salesforce connection
 * breaks (`crm_broken`, A8) or its daily AI budget is spent (`ai_budget`, A9).
 * `paused_from` remembers which state each campaign was in, so a resume puts a
 * dry-run campaign back in dry run instead of making it live.
 *
 * Plan 1B task B7 adds:
 *  - one alert per pause: the UPDATE returns only campaigns that were running,
 *    so a tenant whose campaigns are already paused alerts nothing, however
 *    many ticks hit the same failure;
 *  - the `ai_budget` resume, run on every `touch.plan` tick: a tenant's
 *    budget-paused campaigns go back to `paused_from` once the tenant's spend
 *    for the current UTC day is under its budget — at 00:00 UTC, when the day's
 *    spend starts from zero, or earlier if an admin raises the budget.
 *    `crm_broken` pauses never resume on their own: an admin reconnects
 *    Salesforce and resumes the campaigns.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { budgetMicros, spentTodayMicros } from '../ai/budget.js';
import type { OrgAlert } from '../alerts.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';

export type AutoPauseReason = 'crm_broken' | 'ai_budget';
export const RUNNING_CAMPAIGN_STATUSES = ['dry_run', 'active'] as const;

const PAUSE_WORDS: Record<AutoPauseReason, { lead: string; why: string }> = {
  crm_broken: {
    lead: 'Action needed: paused',
    why: 'the Salesforce connection is broken. Reconnect it in Settings → Connections, then resume each campaign',
  },
  ai_budget: {
    lead: 'Paused',
    why: "today's AI budget is used up. Paused campaigns resume on their own at 00:00 UTC",
  },
};

/** Pure: the one alert line a pause sends. */
export function pauseAlertText(reason: AutoPauseReason, paused: ReadonlyArray<{ id: string; name: string }>): string {
  const { lead, why } = PAUSE_WORDS[reason];
  const noun = paused.length === 1 ? 'campaign' : 'campaigns';
  return `${lead} ${paused.length} ${noun} (${paused.map((p) => p.name).join(', ')}) because ${why}.`;
}

/** Returns the number of campaigns paused (0 when none was running); alerts once when it paused any. */
export async function pauseOrgCampaigns(db: Db, orgId: string, reason: AutoPauseReason, alert?: OrgAlert): Promise<number> {
  const rows = await db
    .update(schema.campaigns)
    // `status` on the right-hand side is the value before this UPDATE.
    .set({ status: 'paused', pauseReason: reason, pausedFrom: sql.raw('status'), updatedAt: sql`now()` })
    .where(and(eq(schema.campaigns.orgId, orgId), inArray(schema.campaigns.status, [...RUNNING_CAMPAIGN_STATUSES])))
    .returning({ id: schema.campaigns.id, name: schema.campaigns.name });
  if (rows.length > 0 && alert) await alert(orgId, pauseAlertText(reason, rows));
  return rows.length;
}

/** Resume every `ai_budget` pause whose tenant is under budget for the current UTC day. Returns how many resumed. */
export async function resumeBudgetPausedCampaigns(deps: { db: Db; now: Date; log: RunnerLogger }): Promise<number> {
  const { db, now, log } = deps;
  const orgs = await db
    .selectDistinct({ id: schema.organizations.id, settings: schema.organizations.settings })
    .from(schema.campaigns)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.campaigns.orgId))
    .where(and(eq(schema.campaigns.status, 'paused'), eq(schema.campaigns.pauseReason, 'ai_budget')));
  let resumed = 0;
  for (const org of orgs) {
    if ((await spentTodayMicros(db, org.id, now)) >= budgetMicros(outreachSettings(org))) continue;
    const rows = await db
      .update(schema.campaigns)
      // Back to the state it was paused from; a pause from before `paused_from` existed resumes to dry run, never live.
      .set({ status: sql`coalesce(${schema.campaigns.pausedFrom}, 'dry_run')`, pauseReason: null, pausedFrom: null, updatedAt: now })
      .where(and(eq(schema.campaigns.orgId, org.id), eq(schema.campaigns.status, 'paused'), eq(schema.campaigns.pauseReason, 'ai_budget')))
      .returning({ id: schema.campaigns.id });
    if (rows.length > 0) log.info({ orgId: org.id, campaignIds: rows.map((r) => r.id) }, 'resumed campaigns paused for the AI budget');
    resumed += rows.length;
  }
  return resumed;
}
```

In A8's `services/outreach-api/src/campaigns/refresh.ts`:
- Add `import type { OrgAlert } from '../alerts.js';` to the imports.
- Change `type RefreshDeps = { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger };` to:
```ts
type RefreshDeps = { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger; alert?: OrgAlert };
```
- Replace `pauseForBrokenCrm` with:
```ts
async function pauseForBrokenCrm(db: Db, log: RunnerLogger, orgId: string, err: unknown, alert?: OrgAlert): Promise<void> {
  const paused = await pauseOrgCampaigns(db, orgId, 'crm_broken', alert);
  log.warn({ orgId, paused, err: errorMessage(err) }, 'salesforce connection unusable; paused the tenant campaigns');
}
```
- In `refreshOrg`, there are two lines that read `if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err);`. The first is in the client `catch`, the second in the per-campaign `catch`. Change both to the line below, keeping each line's indentation:
```ts
    if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err, deps.alert);
```

In A9's `services/outreach-api/src/triage/run.ts`:
- Add `import type { OrgAlert } from '../alerts.js';` to the imports.
- Add this as the last member of `export interface TriageDeps`:
```ts
  /** Alerts once when this tick pauses the tenant's campaigns for the AI budget (plan 1B B7). */
  alert?: OrgAlert;
```
- In `pauseForBudget`, change `const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget');` to:
```ts
  const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget', deps.alert);
```

In `services/outreach-api/src/server.ts`:
- B2 imports `sfWriteAlert` from `./alerts.js`. Make that import `import { campaignsPausedAlert, sfWriteAlert } from './alerts.js';`.
- Add `import { resumeBudgetPausedCampaigns } from './campaigns/pause.js';` next to the other `./campaigns/…` imports.
- After the `killSwitch` lines from Step 3, insert:
```ts
  // Automatic-pause alerts (src/campaigns/pause.ts): log always, ALERT_WEBHOOK_URL when set.
  const pauseAlert = campaignsPausedAlert(console);
```
- In the `'campaign.refresh'` handler, change `await refreshDueCampaigns({ db, clients, now: new Date(), log: console });` to:
```ts
            await refreshDueCampaigns({ db, clients, now: new Date(), log: console, alert: pauseAlert });
```
- In the `'record.triage'` handler, change `await triageDueRecords({ db, clients, model: triageModel, now: new Date(), log: console });` to:
```ts
            await triageDueRecords({ db, clients, model: triageModel, now: new Date(), log: console, alert: pauseAlert });
```
- Replace the `'touch.plan'` entry with:
```ts
      // End AI-budget pauses whose tenant is under budget for today (UTC), then plan due
      // enrollments and queue due rep calls of ACTIVE campaigns (src/planner/run.ts).
      'touch.plan': async () => {
        const now = new Date();
        await resumeBudgetPausedCampaigns({ db, now, log: console });
        await planTick({ db, now, log: console, killSwitch });
      },
```
The resume runs on `touch.plan`, which is unconditional, not on `record.triage`, which runs only when Salesforce and AI are configured. That way a tenant whose AI key was removed still resumes.

- [ ] **Step 14: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test -- src/alerts.test.ts src/campaigns/pause.test.ts 2>&1 | tail -5
```
Expected: the typecheck is clean, and 3 tests pass (1 alerts and 2 pause).
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "pause|refresh|triage/run|Test Files|Tests "
```
Expected:
- `✓ src/campaigns/pause.pg.test.ts (5 tests)` and `✓ src/campaigns/pause-alerts.pg.test.ts (2 tests)`.
- A8's `refresh.test.ts` and A9's `triage/run.test.ts` still pass. They call without `alert`, and their `pausedFrom` expectations are unchanged.
- The `Test Files` line shows no failures.

- [ ] **Step 15: Commit**
```bash
git add services/outreach-api/src/alerts.ts services/outreach-api/src/alerts.test.ts services/outreach-api/src/campaigns/pause.ts services/outreach-api/src/campaigns/pause.test.ts services/outreach-api/src/campaigns/pause.pg.test.ts services/outreach-api/src/campaigns/pause-alerts.pg.test.ts services/outreach-api/src/campaigns/refresh.ts services/outreach-api/src/triage/run.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): alert once per automatic pause; resume AI-budget pauses at the next UTC day"
```

#### Part 4: `GET /api/status`

- [ ] **Step 16: Write the failing tests**

Create `packages/contracts/src/status.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OutreachStatus } from './status.js';

describe('OutreachStatus', () => {
  it('carries the kill switch as a boolean, and nothing else passes', () => {
    expect(OutreachStatus.parse({ killSwitch: true })).toEqual({ killSwitch: true });
    expect(OutreachStatus.safeParse({}).success).toBe(false);
    expect(OutreachStatus.safeParse({ killSwitch: 'on' }).success).toBe(false);
  });
});
```

Create `services/outreach-api/src/routes/status.test.ts`. Its `vi.mock('@cti/auth')` spreads `importOriginal()`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerStatusRoutes } from './status.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const member = { userId: 'U2', orgId: 'O1', email: 'rep@gg.co', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false };
const auth = { authorization: 'Bearer t' };
let app: FastifyInstance | undefined;

async function build(killSwitch: 'on' | 'off'): Promise<FastifyInstance> {
  const cfg = testConfig({ OUTREACH_KILL_SWITCH: killSwitch });
  const { db } = fakeDb({ organizations: [org] });
  app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerStatusRoutes(scope, { db, cfg })] });
  return app;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('GET /api/status', () => {
  it.each([['on', true], ['off', false]] as const)('OUTREACH_KILL_SWITCH=%s → killSwitch %s, for any member', async (value, expected) => {
    state.session = member;
    const res = await (await build(value)).inject({ method: 'GET', url: '/api/status', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killSwitch: expected });
  });

  it('requires a session', async () => {
    state.session = null;
    const res = await (await build('on')).inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 17: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/status.test.ts 2>&1 | tail -6; npm -w services/outreach-api run test -- src/routes/status.test.ts 2>&1 | tail -6
```
Expected: both fail to load, with `Failed to load url ./status.js` (contracts) and `Failed to load url ./status.js` (routes).

- [ ] **Step 18: Implement**

Create `packages/contracts/src/status.ts`:
```ts
import { z } from 'zod';

/** GET /api/status (outreach-api, plan 1B B7): server-wide switches the app shows as banners. */
export const OutreachStatus = z.object({ killSwitch: z.boolean() });
export type OutreachStatus = z.infer<typeof OutreachStatus>;
```
In `packages/contracts/src/index.ts`, add this after `export * from './session.js';`:
```ts
export * from './status.js';
```

Create `services/outreach-api/src/routes/status.ts`:
```ts
/**
 * GET /api/status — server-wide switches the app shows as banners (plan 1B
 * task B7). Any signed-in member may read it.
 */
import type { FastifyInstance } from 'fastify';
import type { OutreachStatus } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { AppConfig } from '../config.js';
import { requireContext } from '../tenancy/scope.js';

export async function registerStatusRoutes(app: FastifyInstance, deps: { db: Db; cfg: Pick<AppConfig, 'OUTREACH_KILL_SWITCH'> }): Promise<void> {
  app.get('/status', async (req, reply) => {
    const ctx = await requireContext(deps.db, req, reply);
    if (!ctx) return;
    return { killSwitch: deps.cfg.OUTREACH_KILL_SWITCH === 'on' } satisfies OutreachStatus;
  });
}
```
In `services/outreach-api/src/server.ts`, add `import { registerStatusRoutes } from './routes/status.js';` with the other `./routes/…` imports. Add this as the last entry of `apiRoutes`:
```ts
      (scope) => registerStatusRoutes(scope, { db, cfg }),
```

- [ ] **Step 19: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w packages/contracts run test -- src/status.test.ts 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```
Expected: the contracts test passes (1 test), and the outreach-api typecheck is clean. The outreach-api suite passes, with `routes/status.test.ts` at 3 tests and the `pgLane` suites skipped.
```bash
cd "$(git rev-parse --show-toplevel)" && grep -n "killSwitch\|pauseAlert\|resumeBudgetPausedCampaigns\|registerStatusRoutes\|'calls.reconcile'" services/outreach-api/src/server.ts
```
Expected lines:
- the three imports (`campaignsPausedAlert`, `resumeBudgetPausedCampaigns`, `registerStatusRoutes`)
- `const killSwitch` and its `if (killSwitch)` warn
- `const pauseAlert = campaignsPausedAlert(console);`, and `alert: pauseAlert` in the `campaign.refresh` and `record.triage` handlers
- `killSwitch` in the `touch.plan` and `sf.write` handlers
- `resumeBudgetPausedCampaigns(` in `touch.plan`
- the `'calls.reconcile'` entry (B6)
- the `registerStatusRoutes(` route entry

- [ ] **Step 20: Commit**
```bash
git add packages/contracts/src/status.ts packages/contracts/src/status.test.ts packages/contracts/src/index.ts services/outreach-api/src/routes/status.ts services/outreach-api/src/routes/status.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): GET /api/status reports the outreach kill switch"
```

#### Part 5: the banner

A12/A13 already show a paused campaign's reason in words, on the campaigns list (`pauseReasonWords`) and in the campaign page's `CampaignBanners`. B7 reuses them. It adds only the kill-switch banner and corrects the `ai_budget` words: the resume happens at 00:00 UTC, which is the same afternoon for a Pacific-time tenant, so "resumes tomorrow" was wrong.

- [ ] **Step 21: Write the failing tests**

Create `apps/outreach-web/src/components/kill-switch-banner.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { KillSwitchBanner } from './kill-switch-banner';

afterEach(() => vi.unstubAllGlobals());

describe('KillSwitchBanner', () => {
  it('shows the banner while the kill switch is on', async () => {
    stubApi({ 'GET /api/status': { killSwitch: true } });
    renderWithProviders(<KillSwitchBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Outreach is switched off.');
  });

  it('renders nothing while the switch is off', async () => {
    const calls = stubApi({ 'GET /api/status': { killSwitch: false } });
    const { container } = renderWithProviders(<KillSwitchBanner />);
    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/api/status'));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status cannot be read (the banner is information, never a gate)', async () => {
    const calls = stubApi({ 'GET /api/status': respond(500, { error: 'boom', code: 'INTERNAL_ERROR' }) });
    const { container } = renderWithProviders(<KillSwitchBanner />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
```
In `apps/outreach-web/src/lib/outreach-words.test.ts` and in `apps/outreach-web/src/components/campaign-detail.test.tsx`, replace the row:
```ts
    ['ai_budget', "Paused: today's AI budget is used up — resumes tomorrow"],
```
with:
```ts
    ['ai_budget', "Paused: today's AI budget is used up — resumes at 00:00 UTC"],
```

- [ ] **Step 22: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w apps/outreach-web run test -- src/components/kill-switch-banner.test.tsx src/lib/outreach-words.test.ts src/components/campaign-detail.test.tsx 2>&1 | tail -12
```
Expected failures:
- `kill-switch-banner.test.tsx` fails to load: `Failed to resolve import "./kill-switch-banner"`.
- The `ai_budget` row fails in each of the other two files: `expected 'Paused: today\'s AI budget is used up — resumes tomorrow' to be …` and `Expected element to have text content`.

- [ ] **Step 23: Implement**

In `apps/outreach-web/src/lib/outreach-words.ts`, replace the line:
```ts
  ai_budget: "Paused: today's AI budget is used up — resumes tomorrow",
```
with:
```ts
  ai_budget: "Paused: today's AI budget is used up — resumes at 00:00 UTC",
```
and add this after `pauseReasonWords`:
```ts

/** Every signed-in page shows this while OUTREACH_KILL_SWITCH is on (plan 1B B7). */
export const KILL_SWITCH_WORDS =
  'Outreach is switched off. No campaign calls reach the dialer and nothing is written to Salesforce until an operator turns it back on. Planning continues.';
```

In `apps/outreach-web/src/lib/outreach-api.ts`, make these edits:
- Add `OutreachStatus,` to the value imports from `@cti/contracts`, between `NeedsReviewResponse,` and `StartConnectionResponse,`.
- Add `status: ['status'] as const,` as the last member of `outreachKeys`.
- Append:
```ts

/** Server-wide switches (plan 1B B7): today, the global kill switch. */
export function getStatus(): Promise<OutreachStatus> {
  return api('/api/status', OutreachStatus);
}
```

Create `apps/outreach-web/src/components/kill-switch-banner.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { getStatus, outreachKeys } from '@/lib/outreach-api';
import { KILL_SWITCH_WORDS } from '@/lib/outreach-words';

/**
 * Shown on every signed-in page while OUTREACH_KILL_SWITCH is on (plan 1B task
 * B7). Renders nothing while loading, when the switch is off, and when the
 * status cannot be read — the banner is information, never a gate.
 */
export function KillSwitchBanner() {
  const status = useQuery({ queryKey: outreachKeys.status, queryFn: getStatus, staleTime: 60_000, refetchInterval: 60_000 });
  if (!status.data?.killSwitch) return null;
  return (
    <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {KILL_SWITCH_WORDS}
    </div>
  );
}
```

In `apps/outreach-web/src/components/app-shell.tsx`, add `import { KillSwitchBanner } from './kill-switch-banner';` after `import { TenantSwitcher } from './tenant-switcher';`. Replace:
```tsx
      <main className="mx-auto max-w-5xl p-6">{children}</main>
```
with:
```tsx
      <main className="mx-auto max-w-5xl p-6">
        <KillSwitchBanner />
        {children}
      </main>
```

- [ ] **Step 24: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test 2>&1 | tail -5 && npm -w apps/outreach-web run typecheck
```
Expected: no failures, and `kill-switch-banner.test.tsx` passes 3 tests. The route tests in `-routes.test.tsx` render the shell. Their fetch stubs answer 404 for `/api/status`, so the banner stays hidden and none of their assertions change. The typecheck is clean.

- [ ] **Step 25: Commit, then run the root verification**
```bash
git add apps/outreach-web/src/lib/outreach-words.ts apps/outreach-web/src/lib/outreach-words.test.ts apps/outreach-web/src/lib/outreach-api.ts apps/outreach-web/src/components/kill-switch-banner.tsx apps/outreach-web/src/components/kill-switch-banner.test.tsx apps/outreach-web/src/components/app-shell.tsx apps/outreach-web/src/components/campaign-detail.test.tsx
git commit -m "feat(outreach-web): kill switch banner; AI-budget pauses resume at 00:00 UTC"
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test 2>&1 | tail -6 && npm run test:pg 2>&1 | tail -4
```
Expected: the typecheck is clean, every workspace's tests pass, and `test:pg` passes with no failures.

---

### Task B8: Deploy — IaC variables, `.env.example`, runbook, README, follow-ups

**Files:**
- Modify `.railway/railway.ts`:
  - line 31 (the `_ctiapi` env object, one line)
  - insert after line 58 (`WORKOS_REDIRECT_URI: preserve(),` in `outreachApi`)
- Replace `services/outreach-api/.env.example`.
- Modify `services/outreach-api/src/config.test.ts`: three imports at the top, plus one `describe` appended.
- Modify `docs/runbooks/outreach-sf-campaigns.md`, which B1 created. Append the sections below after B1's last section.
- Modify `README.md`: insert after the paragraph that starts `**Deploy:**`, which ends `(runbook §5, before 2026-12-01).`.
- Modify `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`: append one section.

Dockerfiles are not touched. A1 already copies `packages/salesforce/package.json` in the root and outreach-api Dockerfiles.

**Interfaces:**
- **Consumes:**
  - Every variable the 1A/1B config reads:
    - A5: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_REDIRECT_URI`, `SALESFORCE_LOGIN_URL`, `SALESFORCE_API_VERSION` (default `v60.0`), `ANTHROPIC_API_KEY`
    - existing: `ALERT_WEBHOOK_URL`
    - B7: `OUTREACH_KILL_SWITCH`, on both services
  - `parseConfig` with `workosEnabled`, `salesforceEnabled` and `aiEnabled`.
  - Root `test:pg` = `npm run build:packages && sh services/outreach-api/scripts/test-pg.sh`.
- **Produces:** the IaC declarations, a `.env.example` that boots as written, the runbook sections, a README pointer and the follow-up entries.

`railway config apply` deletes any Railway variable that `.railway/railway.ts` does not declare. Every variable an operator sets by hand must therefore be declared with `preserve()`. That covers the kill switch on **both** services and `ALERT_WEBHOOK_URL` on outreach-api; without it, the B7 pause alerts would reach only the log.

- [ ] **Step 1: Write the failing test**

In `services/outreach-api/src/config.test.ts`, add these three imports at the top, above the `vitest` import:
```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```
Append to the file:
```ts

describe('.env.example', () => {
  it('boots as written (with real secrets filled in), every optional integration off and the kill switch off', () => {
    const env: Record<string, string> = {};
    const file = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../.env.example'), 'utf8');
    for (const line of file.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    const cfg = parseConfig({ ...env, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32) });
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('off');
    expect(cfg.workosEnabled).toBe(false);
    expect(cfg.salesforceEnabled).toBe(false);
    expect(cfg.aiEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts 2>&1 | tail -8
```
Expected: `1 failed`, with `Error: Invalid environment configuration:` and `- WorkOS: set all three or none; missing WORKOS_API_KEY, WORKOS_CLIENT_ID`. Today's `.env.example` ships `WORKOS_REDIRECT_URI` filled in with an empty key and client id, so a fresh copy of it does not boot.

- [ ] **Step 3: Replace `services/outreach-api/.env.example`**
```dotenv
NODE_ENV=development
API_PORT=4100
API_PUBLIC_URL=http://localhost:4100
# Where the SPA lives for redirects after sign-in (Vite dev server in dev; the API's own origin in prod).
APP_PUBLIC_URL=http://localhost:5175
# Same values as services/cti-api so sessions and encrypted tokens interoperate.
TOKEN_ENCRYPTION_KEY=replace_me_with_64_hex_chars
SESSION_SECRET=replace_me_with_long_random_string
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cti_dev
# WorkOS AuthKit (dashboard -> API Keys / Configuration). Set all three or none;
# unset = the sign-in routes answer 503. Locally the redirect URI is
# http://localhost:4100/api/auth/workos/callback
WORKOS_API_KEY=
WORKOS_CLIENT_ID=
WORKOS_REDIRECT_URI=
# Salesforce Connected App for the company-wide Integration-user connection
# (docs/runbooks/outreach-sf-campaigns.md). Set CLIENT_ID and REDIRECT_URI
# together or neither; unset = the connection routes answer 503 SALESFORCE_DISABLED.
# Locally the redirect URI is http://localhost:4100/api/connections/salesforce/callback
SALESFORCE_CLIENT_ID=
# Only when the Connected App requires a secret for the web server flow.
SALESFORCE_CLIENT_SECRET=
SALESFORCE_REDIRECT_URI=
# https://test.salesforce.com for a sandbox.
SALESFORCE_LOGIN_URL=https://login.salesforce.com
SALESFORCE_API_VERSION=v60.0
# Claude (note triage). Unset = triage is off.
ANTHROPIC_API_KEY=
# pg-boss schema in the shared Postgres.
PGBOSS_SCHEMA=pgboss
# Slack-compatible webhook for automatic-pause and outbox alerts. Unset = alerts go to the log only.
ALERT_WEBHOOK_URL=
CORS_ALLOWED_ORIGINS=
# Global kill switch, on | off. on = no campaign call reaches the dialer and no
# Salesforce write is sent. services/cti-api reads the same variable.
OUTREACH_KILL_SWITCH=off
```

- [ ] **Step 4: Run it to verify it passes**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts 2>&1 | tail -4
```
Expected: no failures.

- [ ] **Step 5: Commit**
```bash
git add services/outreach-api/.env.example services/outreach-api/src/config.test.ts
git commit -m "fix(outreach-api): .env.example boots as written and lists the 1B variables"
```

- [ ] **Step 6: Declare the variables in `.railway/railway.ts`**

On line 31, the one-line `_ctiapi` `env` object, insert `OUTREACH_KILL_SWITCH: preserve(), ` between `NUMBERVERIFIER_VERIFY_KEY: preserve(), ` and `PORT: preserve(), `. The keys stay alphabetical. Nothing else on the line changes.

In the `outreachApi` `env` object, after line 58 (`      WORKOS_REDIRECT_URI: preserve(),`), insert:
```ts
      // Salesforce campaigns (docs/runbooks/outreach-sf-campaigns.md). Set in the
      // dashboard; preserve() keeps `railway config apply` from deleting them.
      SALESFORCE_CLIENT_ID: preserve(),
      SALESFORCE_CLIENT_SECRET: preserve(),
      SALESFORCE_REDIRECT_URI: preserve(),
      SALESFORCE_LOGIN_URL: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ALERT_WEBHOOK_URL: preserve(),
      // Must match @cti/api's value (the runbook's Kill switch section).
      OUTREACH_KILL_SWITCH: preserve(),
```
Check that the file still compiles:
```bash
cd "$(git rev-parse --show-toplevel)" && ./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --skipLibCheck .railway/railway.ts; echo "exit $?"
```
Expected: `exit 0`.

If the Railway CLI is linked to `endearing-comfort`, run the plan. It is read-only. **Never run `railway config apply`**; that is an operator step, described in the runbook below.
```bash
cd "$(git rev-parse --show-toplevel)" && railway config plan
```
Expected: the summary line says `0 to destroy`, and there is no `- Delete variable` line on either service. The add count is `1 to add` while the outreach-api service does not exist yet, and `0 to add` once it does. If the plan shows any `- Delete variable` line, stop and report it. A variable set in Railway but missing from `railway.ts` must be declared with `preserve()` first. If the CLI is not linked, skip this check; the runbook makes it the operator's first deploy step.

- [ ] **Step 7: Commit**
```bash
git add .railway/railway.ts
git commit -m "chore(railway): preserve the outreach 1B variables and the kill switch on both services"
```

- [ ] **Step 8: Append the deploy sections to the runbook**

Append to `docs/runbooks/outreach-sf-campaigns.md`, after B1's last section:
````markdown
## Variables

`.railway/railway.ts` declares every variable below with `preserve()`. The infrastructure-as-code never sets a value, and `railway config apply` never deletes one. A variable that is **not** declared there is deleted by the next apply, so declare a new variable in `railway.ts` before you set it in the dashboard.

**outreach-api → Variables**

| Variable | Value | Unset means |
|---|---|---|
| `SALESFORCE_CLIENT_ID` | Consumer Key of the Connected App (Salesforce setup, above) | The Salesforce routes answer 503 `SALESFORCE_DISABLED`; no refresh or triage tick runs |
| `SALESFORCE_CLIENT_SECRET` | Consumer Secret, only if the Connected App requires a secret for the web server flow | The token exchange sends no secret |
| `SALESFORCE_REDIRECT_URI` | `https://<outreach-api domain>/api/connections/salesforce/callback`. It must equal the Connected App's callback URL exactly | Same as `SALESFORCE_CLIENT_ID`: set both or neither, or the boot fails |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` (`https://test.salesforce.com` for a sandbox) | `https://login.salesforce.com` |
| `ANTHROPIC_API_KEY` | The Anthropic API key used for note triage | No triage tick; no AI spend |
| `ALERT_WEBHOOK_URL` | A Slack-compatible incoming webhook | Alerts go to the deploy log only |
| `OUTREACH_KILL_SWITCH` | `off` | `off` |

**@cti/api → Variables**

| Variable | Value | Unset means |
|---|---|---|
| `OUTREACH_KILL_SWITCH` | `off`, and always the same value as outreach-api's | `off` |

## Plan the infrastructure (read-only)

From the repo root on `main`, with the CLI linked to project `endearing-comfort`:

```bash
railway config plan
```

Read the whole output before doing anything else.

- The summary line must say `0 to destroy`.
- **Stop on any `- Delete variable` line**, on either service. It means a variable is set in Railway but not declared in `.railway/railway.ts`, and the apply would delete it. Declare it with `preserve()` in `railway.ts`, merge that, and plan again.
- The add count depends on what exists already. It is `1 to add` while the outreach-api service has not been created yet (`docs/runbooks/outreach-api-deploy.md` §1), and `0 to add` after that.

`railway config apply` is an operator step. A person runs it after reading the plan. An agent or script working through this runbook stops at the plan and reports what it showed.

## Deploy

1. Merge to `main`. outreach-api, @cti/api and the softphone (@cti/web) all deploy from `main`. outreach-api's pre-deploy migrate applies the campaign migrations.
2. Plan (above). If the plan is clean and something must be created or changed, the operator runs `railway config apply`.
3. Set the outreach-api variables (table above) in the dashboard, then redeploy outreach-api: **Deployments → ⋯ on the latest deployment → Redeploy**.
4. Check `/healthz` → 200 and `/readyz` → `{ ok: true, dbOk: true, jobsOk: true }`. The deploy log must **not** contain `OUTREACH_KILL_SWITCH is on`.
5. Nothing changes in the softphone until a campaign is Live and has rep calls due. Until then, the Campaign calls picker stays hidden.

## Go-live checklist (first tenant)

Do these in order. Each step says what you should see before you go on.

1. [ ] **Salesforce fields and permission set** are deployed and assigned (Salesforce setup, above). On a Lead in Salesforce, the three AI Call Consent fields are visible to the Integration user.
2. [ ] **Connect Salesforce.** Sign in to the outreach app as a tenant admin, go to **Settings → Connections → Connect Salesforce**, and sign in as the Integration user. The page shows the connection as connected, with the Salesforce org and user.
3. [ ] **Consent settings.** On the same page, turn on **Consent from web forms** only if every web form feeding this org carries consent language for calls and texts. Turn on **Consent from inbound calls** if the tenant wants it. Press **Backfill** and write down the two counts.
4. [ ] **First campaign, in dry run.** Go to **Campaigns → New campaign**. Pick a small list view or query (tens of records, not thousands), press Preview, then Create. Set the campaign to **Dry run**.
5. [ ] **Review the plan.** Within 5 minutes the campaign refreshes: the member count and "last refreshed" fill in. A few minutes later the plan fills in. Open the gate audit on several rows: every skipped person must show the reason you expect (consent, Do Not Call, Skip on Dialer, quiet hours). Work through **Needs review**.
6. [ ] **Activate.** Set the campaign to **Live**. On the next `touch.plan` tick (every minute), due rep calls move to the dialer queue.
7. [ ] **A rep starts Campaign calls.** In the softphone's Power dial tab, under the list picker, the rep sees **Campaign calls** with the campaign and its due count. The rep presses **Dial campaign calls**, then works the usual confirm block and **Start dialing**.
8. [ ] **Verify reconcile.** A minute after the run ends, every touch it carried has left `dialing`. Copy the campaign's id from the campaign page's URL and run this read-only query (`railway connect Postgres`):

   ```sql
   \set campaign_id '<paste the campaign id>'
   select t.status, t.outcome, t.skip_reason, count(*)
     from touches t
     join campaign_enrollments e on e.id = t.enrollment_id
    where e.campaign_id = :'campaign_id'
      and t.channel = 'rep_call'
    group by 1, 2, 3
    order by 1, 2, 3;
   ```

   Expect these rows:
   - `sent | connected` for the people the rep spoke to. They show as Conversing in the campaign's plan.
   - `sent | <miss reason>` for misses.
   - `skipped | | <reason>` for people the dialer skipped at build or dial time.
   - `queued` for records a stopped or limited run never reached. They go to the next run.
   - No `dialing` rows more than 10 minutes after the run ended.

## Kill switch

`OUTREACH_KILL_SWITCH=on` stops outreach from reaching anyone. It changes no campaign settings.

- **outreach-api:** no planned rep call is moved to the dialer queue. The Salesforce write outbox holds every row; nothing is lost, and the rows send after the switch is turned off.
- **@cti/api:** the softphone's Campaign calls picker lists nothing, and a start claims nothing.
- **Outreach app:** every page shows a red banner within a minute.

Planning, refresh, triage and reconcile keep running, so the plan stays current and a run already in progress still settles. The switch does **not** stop a power-dial run that is already dialing. If calls must stop now, the rep presses Stop in the softphone.

**Turn it on:** set `OUTREACH_KILL_SWITCH=on` on **both** outreach-api and @cti/api, then deploy both. Railway stages the variable change; deploy it, or use Redeploy. One service alone is not enough. With only outreach-api switched, @cti/api still hands out touches that were already queued. With only @cti/api switched, outreach-api keeps queueing new ones and keeps writing to Salesforce. Confirm in the outreach-api deploy log: `OUTREACH_KILL_SWITCH is on`.

**Turn it off:** set both back to `off` and deploy both. Held touches queue on the next `touch.plan` tick, and held Salesforce writes send on the next `sf.write` tick.

Any value other than `on` or `off` (for example `true` or `1`) fails the boot on purpose.

## Automatic pauses and alerts

Every alert is logged as `alert: …`. It is also posted to `ALERT_WEBHOOK_URL` when that is set.

| What | When | Alert | How it ends |
|---|---|---|---|
| Pause `crm_broken` | The refresh tick finds the tenant's Salesforce connection unusable: none, marked broken, or a token refresh refused (400/401). A Salesforce outage (5xx) does **not** pause. | One critical `campaigns_paused` alert per pause, naming the campaigns | Never on its own. Reconnect Salesforce in Settings → Connections, then resume each campaign from its page. |
| Pause `ai_budget` | Today's (UTC) AI triage spend reached the tenant's daily budget (default $25) | One warning `campaigns_paused` alert per pause | On its own at the first `touch.plan` tick after 00:00 UTC (4–5 pm Pacific). Each campaign goes back to the state it was paused from, so a dry-run campaign stays in dry run. It ends sooner if an admin raises the budget. |
| Salesforce writes failing (no pause) | A queued Salesforce write has failed for 24 hours | One warning `sf_write_failing` alert per row | The row keeps retrying every 6 hours. Fix the cause (field-level security, a validation rule) and it sends on the next try. |

A pause alerts once. Later ticks find the campaigns already paused and stay quiet. If the same tenant pauses again after a resume, that is a new alert.

## Tests against a real database

The reconcile, pause, kill-switch, planner, refresh and triage suites run only against Postgres:

```bash
npm run test:pg
```

That is `npm run build:packages && sh services/outreach-api/scripts/test-pg.sh`, which runs the outreach-api suite with `TEST_DATABASE_URL` set. Plain `npm test` skips those suites, and so does CI today.

## Rollback

- **Fastest:** the kill switch (above). It stops all outreach within one deploy of each service and loses nothing.
- **One tenant or one campaign:** pause its campaigns from their pages.
- **Code:** revert the merge on `main` and let the services redeploy. The campaign migrations only add tables and columns, so leave them in place. Touches left in `dialing` are settled by `calls.reconcile` once the code is redeployed.
````

- [ ] **Step 9: Add the README pointer**

In `README.md`, after the paragraph that starts `**Deploy:** \`docs/runbooks/outreach-api-deploy.md\`` (it ends `(runbook §5, before 2026-12-01).`), insert a blank line and then:
```markdown
**Salesforce campaigns:** `docs/runbooks/outreach-sf-campaigns.md` — Salesforce
fields and permission set, variables, the read-only IaC plan, the go-live
checklist, the kill switch (`OUTREACH_KILL_SWITCH`, set on both outreach-api
and @cti/api), and automatic pauses and alerts.
```

- [ ] **Step 10: Append the follow-ups**

Append to `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`:
```markdown

## Salesforce campaigns (plans 1A and 1B) — follow-ups

- **CTI client convergence.** cti-api calls Salesforce through its own per-rep client. outreach-api uses `@cti/salesforce` on the company-wide Integration-user connection. Move cti-api onto `@cti/salesforce` the next time its Salesforce code is reworked, so there is one client, one error split (auth vs outage) and one retry policy.
- **Real-Postgres lane in CI.** The reconcile, pause, kill-switch, planner, refresh and triage suites run only under `npm run test:pg` on a developer machine; CI skips them. Add a CI job with a Postgres service and `TEST_DATABASE_URL`.
- **Texting hours in phase 2.** Phase 1 plans `sms` touches but never sends them. The phase 2 sender must check the recipient's local texting hours at send time, not only at plan time: a held or deferred touch can come due outside them.
- **Paused runs hold touches.** `calls.reconcile` waits while a campaign run is `active` or `paused`. A run a rep pauses and never resumes keeps its touches in `dialing` indefinitely. Add an idle cutoff, for example release after a paused run has been idle for 4 hours, the way abandoned `ready` runs are stopped after 2 hours.
- **Transient skips consume a touch.** A dial-time skip such as `out_of_hours`, `cooldown` or `daily_cap` settles the touch as `skipped` and advances the sequence. Consider releasing transient skips back to `queued`, so the person is called in the next run instead of losing that day's touch.
- **Two-service kill switch.** `OUTREACH_KILL_SWITCH` must be flipped on outreach-api and @cti/api together. Move it to one database row that both services read, settable from the admin UI, so one action stops everything without a deploy.
- **Stale claim vs. a long run build.** `calls.reconcile` releases a claim that has no run after 10 minutes. If B4's build is still running at that point, its later `attachSession` can stamp a touch another rep has re-claimed, and its `releaseTouches` on failure can release one. Make both match the touch's own claim: `dialer_session_id is null` and `claimed_at` equal to this claim's time.
- **Touch status vocabulary vs spec §9.** The spec lists `claimed` and `awaiting_approval`. The A3 CHECK uses `dialing` for a claimed call and `held`. A connected call is recorded as `sent` with outcome `connected`. Align the spec's §9 list with the CHECK values.
```

- [ ] **Step 11: Run the root verification and commit**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test 2>&1 | tail -6
```
Expected: the typecheck is clean and every workspace passes.
```bash
git add docs/runbooks/outreach-sf-campaigns.md README.md docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md
git commit -m "docs(outreach): Salesforce campaigns runbook — variables, IaC plan, go-live, kill switch, pauses"
```

---

## Skeleton corrections

1. **B5: `onStartFromCampaign` is optional** (`onStartFromCampaign?: …`), not required. App passes it. Other `DialerPanel` renderers, and their tests, compile unchanged and show no picker.
2. **B5: `getCampaignCalls()` parses the body** with B4's `CampaignCallsResponse`; a malformed body hides the picker. `dialer-api.ts` also gains `campaignStartErrorText(e)`, which turns B4's 404 into "No campaign calls are due right now. Another rep may have just started them." The picker lists only campaigns with `due > 0`.
3. **B6: queue-item status `done` counts as connected.** An item becomes `done` only from `connected`, when the rep presses Next, End call or Redial. The skeleton listed `done` among the settled no-connect statuses, which would have recorded most real connects as misses.
4. **B6: outcome and skip reason.** A sent touch's outcome is the **last `no_connect`** item's outcome, ordered by attempt then ordinal. It is not "the last item's outcome", which can be a retry row's dial-time skip. A skipped touch's reason is the first item's `outcome ?? status`, because `unreachable` items have a null outcome.
5. **B6: ended runs.** When a run is `stopped` or `done`, the settled items still decide: a miss whose retry never dialed is `sent`. Only a record the run never reached is released to `queued`. A `dialing` item in a run that ended less than 10 minutes ago waits for Twilio's status callback.
6. **B6: additions the skeleton did not list:**
   - a run left `ready` (never started) for 2 hours is stopped by compare-and-swap on `ready`, and its touches are released;
   - a touch whose run row is gone is released;
   - releasing a touch whose enrollment is no longer `active` (it exited while the call was claimed, and `exitEnrollment` cancels only `planned|held|queued`) makes it `skipped` with the enrollment's exit reason, counted in `touches_done`;
   - a connected touch also counts in `touches_done` and clears `next_touch_at`, guarded by `touches_done < seq`, although `advanceAfterTouch` is not called;
   - non-connected touches of a non-`active` enrollment are counted without moving the sequence;
   - `reconcileCampaignCalls` takes an optional `batch` (default 1000).
7. **Raw `db.execute` returns `timestamptz` columns as strings** under drizzle's node-postgres driver. Pool `query` returns `Date`s. `reconcile.ts` converts with `toDate`, and any other raw-execute reader of timestamps must do the same.
8. **B4: `attachSession` and `releaseTouches` should match the touch's own claim.** They should also require `dialer_session_id is null`, and ideally `claimed_at` equal to that claim's time, not only `status = 'dialing'`. Otherwise a build that outlives reconcile's 10-minute stale-claim release can stamp or release a touch another rep has re-claimed. B6 itself is safe, because every write compares on its own session id. This is recorded in the follow-ups.
9. **B7 relies on A8's `campaigns.paused_from`** (A8 Skeleton correction 1) and on A8's `pauseOrgCampaigns`. B7 adds no migration. The resume returns each campaign to `coalesce(paused_from, 'dry_run')`, so a dry-run campaign is never made live, and it clears `paused_from` and `pause_reason`. `crm_broken` pauses never auto-resume.
10. **B7: the AI-budget resume.** "Auto-resume at the next UTC day" is implemented as "resume while today's (UTC) spend is under the budget", checked at the start of every `touch.plan` tick. No `paused_at` column is needed, and a budget an admin raises takes effect the same day. It runs on `touch.plan`, which always has a worker, not on `record.triage`, which runs only with Salesforce and AI configured.
11. **B7: `OUTREACH_KILL_SWITCH` is read by both services.** Each has its own config key, and every gate is an additive optional parameter.
    - outreach-api:
      - `promoteQueuedCalls(db, now, { killSwitch })` is the gate; A10's `planTick` passes `PlanDeps.killSwitch` through, so planning continues;
      - `drainOutbox` gets `DrainDeps.killSwitch`.
    - cti-api gates `dueCampaignCalls(…, { killSwitch })` and `startCampaignCalls` (`deps.killSwitch`), not `claimCampaignTouches`, which B4 moved into `@cti/db` as the shared claim protocol. The effect is the same: nothing is claimed, and the start answers B4's 404.
    - B7 never writes `pause_reason = 'kill_switch'`. The switch changes no campaign status, and that value stays reserved in A7's vocabulary.
12. **B7: the status route.** `GET /status` is served at `GET /api/status`, under the `/api` scope like every route. It requires a session (`requireContext`). Its body is a new contract, `OutreachStatus = z.object({ killSwitch: z.boolean() })`, in `packages/contracts/src/status.ts`.
13. **B7: alerts reuse B2's plumbing.** The shape is `(orgId: string, message: string) => Promise<void>`, the same as `DrainDeps.alert` and `sfWriteAlert`; it is named `OrgAlert`.
    - `alerts.ts` gains the kind `'campaigns_paused'` and `campaignsPausedAlert(logger)`, a warning. A `crm_broken` message starts "Action needed:".
    - `pauseOrgCampaigns` gains an optional fourth `alert`. It alerts only when its UPDATE paused something, which makes it once per pause.
    - `RefreshDeps.alert?` and `TriageDeps.alert?` thread the alert through.
    - The outbox's 24-hour alert is B2's (`sfWriteAlert`, kind `sf_write_failing`), not B7's.
14. **B7: web.** The paused-campaign banner with the reason in words already ships in A12/A13: `pauseReasonWords` on the list, and `CampaignBanners` on the campaign page. B7 adds only the kill-switch banner. It lives in `AppShell`, so it shows on every signed-in page, not just the campaign pages, and its words are in `outreach-words.ts` (`KILL_SWITCH_WORDS`). B7 also corrects A12's `ai_budget` words from "resumes tomorrow" to "resumes at 00:00 UTC", which is the same afternoon in Pacific time, and updates the two test rows.
15. **B8: deploy details.**
    - B8 also `preserve()`s `ALERT_WEBHOOK_URL` on outreachApi; undeclared variables are deleted by apply, so without it the B7 alerts never leave the log.
    - B8 declares `OUTREACH_KILL_SWITCH` on `_ctiapi` as well as on outreachApi.
    - B8 appends to the runbook that B1 creates.
    - The real-PG suites run through root `npm run test:pg`.
    - The follow-ups go into the existing `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md` as a new section. They include five beyond the skeleton's three: paused runs, transient skips, the two-service switch, the claim race, and the spec §9 vocabulary.
16. **Queue options.** `calls.reconcile` reuses A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`), not the skeleton's `'singleton'` (A8 Skeleton correction 2).
17. **B8 fixes an existing bug in `.env.example`.** It shipped `WORKOS_REDIRECT_URI` filled in with an empty key and client id, which fails `parseConfig` ("set all three or none"). The redirect URI is now empty, with the local value in a comment, and a config test boots the file as written.
