# CTI Softphone Redesign — Design Spec

**Date:** 2026-07-23
**Status:** Approved direction, pending spec review → implementation plan

## Goal

Restyle the CTI softphone (`apps/cti-web`) into a **clean, modern, minimalist** visual
language — the Stripe/Notion flavor — with **better contrast** than today, and gate the
**Reputation** and **Numbers** tabs to admins only.

## Approved visual direction (locked via brainstorming)

Validated against a live mockup of the Dial screen the user approved:

- **Warm white** surfaces, one calm card with a soft layered shadow.
- **Crisp type hierarchy** — strong near-navy ink for primary, quiet gray for secondary, tabular numerals.
- **Gentle color for meaning only** — a single **indigo** accent for "selected/interactive"
  (active tab, avatar, focus); **green** reserved strictly for the call action and the
  connected/success state; amber/red for warnings/errors.
- **Circular dialpad keys** with a soft neutral fill and generous spacing (iOS-dialer feel).
- **Hairline-clean nav**, borderless quiet fills, no glass, no gradients, restrained shadows.

Rejected on the way here: all liquid-glass directions (dark aurora, true iOS-26 glass,
vibrant gradient, warm porcelain, mono-accent) and two earlier light-frosted takes.

## Scope

### A. Admin nav gating (functional)

`apps/cti-web/src/App.tsx` `navItems`: **move `reputation` into the existing
`me.user.isAdmin` group** (which already holds `admin`/"Numbers" and `calls`). Result:

- **Rep (non-admin):** Dial · Power Dial · Recent · Settings (4 tabs)
- **Admin:** Dial · Power Dial · Recent · **Reputation** · **Numbers** · **Calls** · Settings (7 tabs)

`Numbers` and `Calls` are already admin-only; this adds `Reputation`. The gate is UI-level
(the tab is hidden); the Reputation data endpoint is not newly server-gated in this change
— see Out of Scope.

### B. Visual redesign — clean/minimalist, across every screen

Applied to the whole softphone via the shared design system, `apps/cti-web/src/styles.css`
(~1180 lines, token-driven). Every screen inherits it: header + nav (`App.tsx`), Dial
(`Dialpad.tsx`), Power Dial (`DialerPanel.tsx`), Recent (`RecentCalls.tsx`), Reputation
(`ReputationPanel.tsx` + `VerdictPanel.tsx`), Numbers (`AdminPanel.tsx`), Calls
(`CallLog.tsx`), Settings (`SettingsPanel.tsx`), the active/incoming call states
(`CallScreen.tsx`, `IncomingScreen.tsx`), wrap-up (`WrapupForm.tsx`), toasts and banners.

**Design tokens (light theme — the `cti-web` target).** Retune the existing
`:root[data-theme="light"]` custom properties to these approved values (keep the token
*names* so components need no churn):

| Token | New value | Role |
|---|---|---|
| `--bg-1` | `#ffffff` | panel surface |
| `--bg-0` | `#f4f5f7` | app/canvas behind panel |
| `--bg-2` / `--surface-1` | `#f6f7f9` | quiet fill (dial keys, chips) |
| `--surface-2` / hover | `#eef0f4` | hover fill |
| `--surface-3` / pressed | `#e7eaf0` | pressed fill |
| `--hairline` | `#e6e9ef` | default borders/dividers |
| `--hairline-strong` | `#dfe3ea` | stronger dividers |
| `--text` | `#1a1f36` | primary ink |
| `--text-muted` | `#697386` | secondary |
| `--text-dim` | `#8a94a6` | tertiary / placeholder |
| `--accent` | `#635bff` | indigo — selected/interactive |
| `--accent-soft` | `rgba(99,91,255,.09)` | accent fill |
| `--accent-glow` | `rgba(99,91,255,.26)` | focus ring |
| `--good` / call green | `#30a46c` | call action + success |
| `--warn` | `#b8730a` | warning (AA-contrast amber) |
| `--bad` | `#d92d20` | error/danger |
| `--shadow-soft` | `0 1px 2px rgba(16,24,40,.05), 0 18px 44px -14px rgba(16,24,40,.20)` | card depth |

**Component structural retunes (beyond tokens):**

- **Dialpad keys** (`.key`/`Dialpad.tsx`): fixed circular keys — `border-radius:50%`,
  ~74px, `gap:~14px`, soft `--surface-1` fill, `--surface-2` on hover, digit
  `~23px/550` in `--text`, letters `~8.5px/650` in `--text-dim`.
- **Nav** (`.nav .tab`): quiet tabs, label `~10px/600`, inactive `--text-dim`, active
  `--accent` (icon + label). No drop-shadow glow; a clean top hairline divider.
- **Cards/panels/sections**: `--bg-1` surface, `--hairline` border, `--shadow-soft`, radii
  from the `--r-*` scale (panel `--r-lg` ~20px; inputs/cards ~11–14px).
- **Buttons**: primary = `--accent` on white text; call = `--good` green with a soft green
  shadow; danger = `--bad`; secondary = quiet fill. Consistent height + radius.
- **Inputs/fields**: white, `1px --hairline` border, `--text-dim` placeholder.
- **Header**: avatar (accent circle w/ initials) + name (`15/600`) + status
  (dot + `--text-muted`).

**Better contrast:** primary text `#1a1f36` on `#ffffff` ≈ 14:1 (well past WCAG AA);
secondary `#697386` ≈ 4.9:1 (AA). No body text below AA.

### Desktop app (`cti-desktop`)

`styles.css` was historically "kept identical" across `cti-web` and `cti-desktop`.
The **light theme** is the approval target here. To keep the shared system coherent, the
**dark theme** tokens (`:root` default) are updated to the same clean-minimalist language's
dark equivalents (same indigo accent, same ink hierarchy, circular keys, restrained
shadows) so the desktop menubar app stays consistent and also gains better contrast. If the
desktop copy has drifted, the plan will re-sync it. Pixel-level approval remains on the web
softphone.

## Approach

**Token-first.** Components already consume CSS custom properties, so redefining the theme
tokens propagates most of the change automatically; then a targeted pass retunes the
handful of component classes that need structural change (circular keys, nav, cards,
buttons, inputs). This minimizes churn and risk versus rewriting components.

Rejected alternatives: rewriting each component's styles from scratch (needless churn); a
parallel new stylesheet swapped at runtime (two systems to maintain).

## Out of scope

- No functional/behavioral changes to dialing, telephony, firewall, or data.
- No new dependencies (Inter is already loaded; no UI framework).
- No new server-side gating of the Reputation **data** endpoint — this change hides the tab
  for non-admins only. (Flagged as a follow-up if reps must be fully blocked from number-health data.)
- No web dark-mode toggle — `cti-web` stays locked to light for Lightning.
- No layout/IA restructure of panels beyond styling; same screens, same components.

## Testing & verification

- CSS is not unit-tested. Gate on: `npm run build:web` succeeds and the existing
  `cti-web` test suite stays green (its assertions are on text/logic, e.g. `DialerPanel`
  labels like "Run complete", "Power dial a list" — keep that text and structure stable).
- **Visual verification:** screenshot the softphone across screens (Dial, Power Dial,
  Recent, Reputation, Numbers, Calls, Settings, active/incoming call) and compare against
  the approved mockup for consistency and contrast.
- **Admin gating:** confirm a non-admin `/auth/me` renders 4 tabs (no Reputation/Numbers/
  Calls) and an admin renders all 7.
- Confirm the desktop app still builds if its stylesheet is in sync.

## Risks

- `styles.css` is large and central; the redesign is a broad, coherent token + component
  pass. Mitigate by keeping token *names* and test-referenced class names/text stable, and
  verifying both apps build.
- Shared file ↔ desktop: the dark theme must be retuned in the same pass or the desktop app
  looks half-migrated.
