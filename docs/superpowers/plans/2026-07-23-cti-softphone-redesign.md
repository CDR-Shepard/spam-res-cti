# CTI Softphone Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `cti-web` softphone into a clean/minimalist (Stripe/Notion) design with better contrast and circular dialpad keys, and gate the Reputation tab to admins.

**Architecture:** Token-first. `apps/cti-web/src/styles.css` is a design-system driven by CSS custom properties; most of the restyle happens by replacing the light-theme token *values* (every component already consumes the tokens), then a small set of structural class retunes (circular dialpad, nav, avatar, button/call shadows). One functional change: the tab list moves to a pure `navTabsFor(isAdmin)` helper so Reputation is admin-only.

**Tech Stack:** React 18 + TypeScript + Vite, plain CSS (no UI framework), Vitest. Inter font (already loaded via Google Fonts `@import` in styles.css).

## Global Constraints

- `cti-web` is locked to the **light** theme (`<html data-theme="light">`) — do not add a web dark-mode toggle.
- Keep every existing CSS **token name** (`--bg-*`, `--surface-*`, `--text*`, `--accent`, `--good`, etc.) — only change values. Components must need no churn.
- No new dependencies. No UI framework. Keep the Inter `@import`.
- **Color semantics:** indigo `--accent` (`#635bff`) is the ONLY "selected/interactive" color; green `--good` (`#30a46c`) is reserved for the call action + connected/success; amber/red for warn/error. Do not use green for selection.
- Circular dialpad keys.
- Body text must meet WCAG AA (≥4.5:1). Primary ink `#1a1f36` on `#ffffff` and secondary `#697386` on white both pass.
- Keep text/labels that tests assert on unchanged (e.g. `DialerPanel` strings "Run complete", "Power dial a list", "Opportunities"). Keep class names stable.
- `styles.css` is shared in spirit with `cti-desktop`; the dark theme (`:root` default) is retuned in the same pass so the desktop app stays coherent.
- Verify with: `cd apps/cti-web && npx tsc --noEmit && npx vitest run` (must stay green) plus a visual screenshot pass. Existing suite is 20+ tests.

---

### Task 1: Gate the Reputation tab to admins (pure nav helper)

**Files:**
- Create: `apps/cti-web/src/nav.ts`
- Create: `apps/cti-web/src/nav.test.ts`
- Modify: `apps/cti-web/src/App.tsx` (the `type Tab` at line ~37 and the `navItems` array at line ~1075)

**Interfaces:**
- Produces: `type Tab = 'dialer' | 'powerdial' | 'recent' | 'reputation' | 'admin' | 'calls' | 'settings'`; `interface NavTab { id: Tab; label: string }`; `function navTabsFor(isAdmin: boolean): NavTab[]`.
- Consumes (in App.tsx): `me.user.isAdmin: boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/cti-web/src/nav.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { navTabsFor } from './nav';

describe('navTabsFor', () => {
  it('a rep (non-admin) sees only rep tabs — no Reputation, Numbers, or Calls', () => {
    expect(navTabsFor(false).map((t) => t.id)).toEqual(['dialer', 'powerdial', 'recent', 'settings']);
  });

  it('an admin sees every tab, with Reputation/Numbers/Calls between Recent and Settings', () => {
    expect(navTabsFor(true).map((t) => t.id)).toEqual([
      'dialer', 'powerdial', 'recent', 'reputation', 'admin', 'calls', 'settings',
    ]);
  });

  it('labels are stable', () => {
    const byId = Object.fromEntries(navTabsFor(true).map((t) => [t.id, t.label]));
    expect(byId).toMatchObject({ admin: 'Numbers', calls: 'Calls', reputation: 'Reputation', dialer: 'Dial' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cti-web && npx vitest run src/nav.test.ts`
Expected: FAIL — cannot find module `./nav`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cti-web/src/nav.ts`:
```ts
export type Tab = 'dialer' | 'powerdial' | 'recent' | 'reputation' | 'admin' | 'calls' | 'settings';

export interface NavTab {
  id: Tab;
  label: string;
}

/**
 * The bottom-nav tabs, in order, for a given rep. Reputation, Numbers (`admin`)
 * and Calls are admin-only (the corresponding endpoints also 403 non-admins);
 * every rep gets Dial, Power Dial, Recent, and Settings.
 */
export function navTabsFor(isAdmin: boolean): NavTab[] {
  return [
    { id: 'dialer', label: 'Dial' },
    { id: 'powerdial', label: 'Power Dial' },
    { id: 'recent', label: 'Recent' },
    ...(isAdmin
      ? ([
          { id: 'reputation', label: 'Reputation' },
          { id: 'admin', label: 'Numbers' },
          { id: 'calls', label: 'Calls' },
        ] as NavTab[])
      : []),
    { id: 'settings', label: 'Settings' },
  ];
}
```

- [ ] **Step 4: Wire App.tsx to the helper**

In `apps/cti-web/src/App.tsx`:
1. Delete the local `type Tab = ...` line (~line 37).
2. Add to the imports near the top: `import { navTabsFor, type Tab } from './nav';`
3. Replace the `navItems` array (~lines 1075-1090) with an icon lookup + the helper. Put this `iconFor` map just above the `navItems` line:
```tsx
  const iconFor: Record<Tab, JSX.Element> = {
    dialer: <GridIcon />,
    powerdial: <ZapIcon />,
    recent: <ClockIcon />,
    reputation: <ShieldIcon />,
    admin: <SettingsIcon />,
    calls: <PhoneOutgoingIcon />,
    settings: <UserIcon />,
  };
  const navItems = navTabsFor(me.user.isAdmin).map((t) => ({ ...t, icon: iconFor[t.id] }));
```
(The `navItems.map((i) => <button ... >)` render below stays unchanged — it reads `i.id`, `i.label`, `i.icon`.)

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/cti-web && npx vitest run src/nav.test.ts && npx tsc --noEmit`
Expected: nav tests PASS; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/cti-web/src/nav.ts apps/cti-web/src/nav.test.ts apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): gate Reputation tab to admins via pure navTabsFor helper"
```

---

### Task 2: Replace the light-theme design tokens

This is the propagating change — every component reads these variables, so most of the visual restyle lands here.

**Files:**
- Modify: `apps/cti-web/src/styles.css` — the `:root[data-theme="light"]` block (lines ~56-83).

- [ ] **Step 1: Replace the light token block**

Replace the entire `:root[data-theme="light"] { ... }` block with:
```css
:root[data-theme="light"] {
  color-scheme: light;
  --bg-0: #ffffff;           /* app canvas — clean white */
  --bg-1: #ffffff;           /* panels / cards surface */
  --bg-2: #f6f7f9;           /* nav / subtle fill */
  --surface-1: #f6f7f9;      /* card + dial-key fill (subtle gray block on white) */
  --surface-2: #eef0f4;      /* hover fill */
  --surface-3: #e7eaf0;      /* pressed fill */
  --hairline: #e6e9ef;
  --hairline-strong: #dfe3ea;
  --text: #1a1f36;           /* primary ink (~14:1 on white) */
  --text-muted: #697386;     /* secondary (~4.9:1 — AA) */
  --text-dim: #8a94a6;       /* tertiary / placeholder */
  --accent: #635bff;         /* indigo — selected/interactive ONLY */
  --accent-soft: rgba(99, 91, 255, 0.09);
  --accent-glow: rgba(99, 91, 255, 0.26);

  --good: #30a46c;           /* call action + success/connected */
  --warn: #b8730a;
  --bad: #d92d20;
  --lime: #5f9112;
  --orange: #cd5a10;

  --ambient-top: transparent; /* flat, minimal canvas — no blue/green glow */
  --ambient-bot: transparent;
  --shadow-soft: 0 1px 2px rgba(16, 24, 40, 0.05), 0 18px 44px -14px rgba(16, 24, 40, 0.20);
  --toast-bg: rgba(255, 255, 255, 0.98);
}
```

- [ ] **Step 2: Verify build + tests still green**

Run: `cd apps/cti-web && npx tsc --noEmit && npx vitest run`
Expected: tsc exits 0; all tests PASS (token changes don't touch logic).

- [ ] **Step 3: Visual check**

Run the dev server and screenshot the Dial screen:
```bash
cd apps/cti-web && npm run dev
```
Open the served URL, confirm: white panel, near-black digits, gray dial keys, indigo active tab, green call button. (Circular keys come in Task 3.)

- [ ] **Step 4: Commit**

```bash
git add apps/cti-web/src/styles.css
git commit -m "feat(cti-web): clean/minimal light design tokens (Stripe/Notion palette)"
```

---

### Task 3: Circular dialpad keys

**Files:**
- Modify: `apps/cti-web/src/styles.css` — `.dialpad` and `.dialpad .key` blocks (lines ~376-400).

- [ ] **Step 1: Replace the `.dialpad` + `.dialpad .key` rules**

Replace the existing `.dialpad { ... }` and `.dialpad .key { ... }` (and its `:hover`/`:active`/`.num`/`.sub`) with:
```css
.dialpad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin: 8px auto 14px;
  max-width: 280px;
  justify-items: center;
}
.dialpad .key {
  width: 74px; height: 74px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 1px;
  border-radius: 50%;
  background: var(--surface-1);
  transition: background 100ms ease, transform 60ms ease;
}
.dialpad .key:hover { background: var(--surface-2); }
.dialpad .key:active { background: var(--surface-3); transform: scale(0.95); }
.dialpad .key .num {
  font-size: 23px; font-weight: 550;
  font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
  color: var(--text);
}
.dialpad .key .sub {
  font-size: 8.5px; font-weight: 650;
  text-transform: uppercase; letter-spacing: 0.16em;
  color: var(--text-dim);
  margin-top: 1px;
}
```

- [ ] **Step 2: Verify build + tests + visual**

Run: `cd apps/cti-web && npx vitest run` (green), then screenshot the Dial screen: keys are now circular, ~74px, with breathing room, on a white panel.

- [ ] **Step 3: Commit**

```bash
git add apps/cti-web/src/styles.css
git commit -m "feat(cti-web): circular dialpad keys"
```

---

### Task 4: Nav + header + avatar polish

**Files:**
- Modify: `apps/cti-web/src/styles.css` — `.nav`, `.nav .tab*` (lines ~213-233); `.avatar`, `.identity .name`, `.identity .status` (lines ~139-155).

- [ ] **Step 1: Replace the nav rules**

Replace the `.nav { ... }` through `.nav .tab.active svg { ... }` block (lines ~213-233) with:
```css
.nav {
  display: flex;
  align-items: center;
  padding: 8px 10px 12px;
  border-top: 1px solid var(--hairline);
  background: var(--bg-1);
}
.nav .tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding: 5px 4px;
  color: var(--text-dim);
  border-radius: var(--r-sm);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.01em;
  transition: color 100ms ease;
}
.nav .tab svg { width: 20px; height: 20px; }
.nav .tab:hover { color: var(--text-muted); }
.nav .tab.active { color: var(--accent); }
```
(Note: the `.nav .tab.active svg { filter: drop-shadow(...) }` glow line is intentionally removed for a flatter look.)

- [ ] **Step 2: Replace the avatar + identity type**

Replace the `.avatar { ... }` rule (lines ~139-147) with:
```css
.avatar {
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--accent);
  display: grid; place-items: center;
  color: white; font-weight: 600; font-size: 11px;
  letter-spacing: 0.04em;
}
```
Then bump identity legibility — change `.identity .name` `font-size: 12px` → `13px`, and `.identity .status` `font-size: 10px` → `11px` (lines ~151-155). Leave `.avatar.photo` unchanged.

- [ ] **Step 3: Verify + commit**

Run: `cd apps/cti-web && npx vitest run` (green); screenshot header + nav (indigo active tab, solid-indigo avatar, readable status).
```bash
git add apps/cti-web/src/styles.css
git commit -m "feat(cti-web): clean nav, header, and avatar"
```

---

### Task 5: Buttons, call button, and focus rings

**Files:**
- Modify: `apps/cti-web/src/styles.css` — `.btn.primary` (lines ~278-283); the `.call-btn` rule (search for `.call-btn` — it follows `.calldock` around line ~405+).

- [ ] **Step 1: Soften the primary button shadow**

Replace `.btn.primary { ... }` (lines ~278-282) with:
```css
.btn.primary {
  background: var(--accent);
  color: white;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 6px 16px -6px var(--accent-glow);
}
```
(Leave `.btn.primary:hover`, `.btn.ghost`, `.btn.danger`, etc. unchanged — they already read the retuned tokens.)

- [ ] **Step 2: Make the call button clean green**

Find the `.call-btn { ... }` rule. Ensure its background is the green token and give it a soft green shadow. Set/replace these properties on `.call-btn`:
```css
  background: var(--good);
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 10px 22px -6px rgba(48, 164, 108, 0.5);
```
(Remove any `--call` gradient / `--call-glow` usage on `.call-btn`; keep its size, shape, and icon rules.)

- [ ] **Step 3: Verify + commit**

Run: `cd apps/cti-web && npx vitest run` (green); screenshot the Dial screen call button (solid green, soft shadow) and any primary button (indigo, subtle shadow).
```bash
git add apps/cti-web/src/styles.css
git commit -m "feat(cti-web): retune primary + call buttons to the new palette"
```

---

### Task 6: Per-screen visual pass + contrast fixes

The token change propagates, but each screen may have a class with a hardcoded color or thin contrast. Walk every screen, screenshot it, and fix regressions using tokens.

**Files (screens to audit, all under `apps/cti-web/src/components/`):**
- `DialerPanel.tsx` (Power Dial) · `RecentCalls.tsx` (Recent) · `ReputationPanel.tsx` + `VerdictPanel.tsx` (Reputation) · `AdminPanel.tsx` (Numbers) · `CallLog.tsx` (Calls) · `SettingsPanel.tsx` (Settings) · `CallScreen.tsx` · `IncomingScreen.tsx` · `WrapupForm.tsx`
- Their styles live in `apps/cti-web/src/styles.css`.

- [ ] **Step 1: Find hardcoded colors that bypass the token system**

Run:
```bash
cd apps/cti-web/src && grep -nE "#[0-9a-fA-F]{3,6}|rgba?\(" styles.css | grep -vE "var\(|:root|--" | grep -vE "rgba\(255, ?255, ?255|rgba\(0, ?0, ?0|rgba\(16, ?24, ?40|rgba\(48, ?164" | head -60
```
Expected: a short list of literal colors outside the token blocks (e.g. old brand blues/greens like `#5b8cff`, `#22c55e`). For each, replace with the nearest token (`--accent`, `--good`, `--text`, `--surface-*`) so the screen matches the system. Leave semantic grade colors (`--lime`/`--orange`) alone.

- [ ] **Step 2: Screenshot each screen and eyeball contrast/spacing**

With `npm run dev` running, visit each tab (as an admin so every screen is reachable) and the call states. For each, confirm: white surfaces, near-black primary text, `--text-muted` (not `--text-dim`) for anything that must be read, indigo only for selection, green only for call/success. Fix any element still using a pre-redesign color or sitting below AA by swapping to the correct token.

- [ ] **Step 3: Verify + commit**

Run: `cd apps/cti-web && npx tsc --noEmit && npx vitest run` (green).
```bash
git add apps/cti-web/src/styles.css apps/cti-web/src/components
git commit -m "feat(cti-web): clean-minimal pass across all softphone screens"
```

---

### Task 7: Dark-theme token parity (desktop coherence)

`styles.css` is shared with `cti-desktop`, which uses the default (dark) theme. Retune the dark tokens to the same clean-minimal language so the desktop app stays consistent and gains the same contrast + accent.

**Files:**
- Modify: `apps/cti-web/src/styles.css` — the `:root { ... }` default (dark) token block (lines ~17-53).

- [ ] **Step 1: Replace the dark accent + ink to match the new system**

In the `:root { ... }` (default/dark) block, change these values (leave the radii `--r-*` and the `--bg-*`/`--surface-*` dark surfaces as-is unless they clash):
```css
  --accent: #7c78ff;                       /* indigo, lightened for dark bg */
  --accent-soft: rgba(124, 120, 255, 0.16);
  --accent-glow: rgba(124, 120, 255, 0.34);
  --good: #35c98a;                         /* call/success green on dark */
  --warn: #f5a623;
  --bad: #f4514e;
  --text: #f4f6f9;
  --text-muted: #aab2c0;                   /* lifted for AA on dark */
  --text-dim: #737d8c;
```
The `.call-btn` rule from Task 5 is theme-agnostic (it points at `--good`), so it works here too. Set `--ambient-top: transparent;` and `--ambient-bot: transparent;` in this block as well for a flat dark canvas consistent with the light theme.

- [ ] **Step 2: Verify build + tests**

Run: `cd apps/cti-web && npx tsc --noEmit && npx vitest run`
Expected: green. (No desktop build here; the shared file just stays coherent. If `apps/cti-desktop/src/styles.css` is a separate copy, re-sync it from `apps/cti-web/src/styles.css` in this step.)

- [ ] **Step 3: Commit**

```bash
git add apps/cti-web/src/styles.css
git commit -m "feat(cti-web): dark-theme token parity for the clean-minimal system"
```

---

### Task 8: Final verification + deploy

**Files:** none (verification only).

- [ ] **Step 1: Full green check**

```bash
cd apps/cti-web && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc 0; all tests pass; production build succeeds.

- [ ] **Step 2: Admin vs non-admin nav check**

Confirm from Task 1's tests (green) that `navTabsFor(false)` → 4 tabs and `navTabsFor(true)` → 7 tabs. In the running app, an admin sees Reputation/Numbers/Calls; a non-admin does not.

- [ ] **Step 3: Deploy (project convention: push to `main` → Railway auto-deploy)**

```bash
git push origin main
```
Then confirm the deploy is healthy: `curl -s -o /dev/null -w "%{http_code}\n" https://ctiapi-production.up.railway.app/healthz` → `200`, and the `/cti/` bundle serves the new styles. Screenshot the live softphone in Salesforce to confirm the redesign renders inside Lightning.

---

## Notes for the implementer

- The single functional change is Task 1 (Reputation gating) — the only unit-testable piece. Tasks 2-7 are CSS; their "test" is `tsc`/`vitest` staying green plus a visual screenshot. Never skip the screenshot.
- Do not rename CSS classes or the `DialerPanel` UI strings the tests assert on.
- If a screen looks wrong after the token swap, the fix is almost always "an element used a literal color instead of a token" (Task 6, Step 1) — prefer fixing it with a token over adding new literals.
