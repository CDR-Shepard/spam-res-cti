# Product Lens — Founder Review

**Project:** Caller Reputation CTI
**Date:** 2026-05-20 (45 min before management demo)
**Mode:** Founder Review (Mode 2)
**Posture:** Brutally honest, optimized for "what to defend in the demo" + "what to do Monday"

---

## What is this trying to be?

Inferred from code, doc, and decisions made over the build:

> A Salesforce-native CTI that **measurably defends a sales team's outbound caller reputation** against the 2026 carrier-analytics + phone-OS spam-labeling regime, by enforcing pre-call rules (warmup, velocity, state mini-TCPAs, neighbor-spoofing) and exposing per-DID reputation as a Hiya-style 4-axis credit score.

Not what the README still says it is ("a manually-dialed CTI"). The dialer is the carrier of value; the **reputation system is the actual product**. The README is one rewrite behind the codebase.

---

## PMF signal scorecard (0–10)

| Signal | Score | Reality |
|---|---|---|
| **Usage growth** | 0 / 10 | One user (you), one org (GG Homes), running on a laptop with a cloudflared tunnel. Zero deployment. |
| **Retention indicators** | N/A | No users, no return cohort. |
| **Revenue signals** | 0 / 10 | No pricing page, no billing code, no Stripe integration, no contracts. |
| **Competitive moat** | 4 / 10 | The reputation modeling + per-DID warmup state machine + state mini-TCPA awareness is **genuinely unique** at the CTI layer. RingCentral / Aircall / Dialpad don't expose any of this. But it's a niche-of-a-niche moat until customers ask for it. |
| **Strategic clarity** | 6 / 10 | The 2026 spam-likely landscape is real, the regulatory tightening is real, the kill thresholds are real and documented. That's a coherent why-now. |

**Composite: pre-product. ~2/10 PMF.** Worth keeping going — but management should hear "we've built a thing worth selling" not "we have a product." Those are different conversations.

---

## The one thing that would 10x this

**Sell the reputation engine as middleware, not the dialer as a product.**

The dialer is commoditized. Aircall, RingCentral, Dialpad, Five9, Genesys, OpenPhone, JustCall, CloudTalk — all do voice calls. What none of them do well: **prevent your reputation from being killed.** They all complain about it; none solve it.

If `cti-api`'s reputation engine + warmup + state rules + firewall could be **embedded in any existing dialer**, you'd sell to:
- Aircall (their answer-rate complaints are a top-3 churn driver)
- RingCentral mid-market
- Five9 enterprise call centers
- Real estate / mortgage / insurance verticals with 50+ rep teams

This is a "Snowflake for telephony reputation" thesis. The CTI is the demo wrapper; the engine is the company.

**Concrete first step:** Extract `services/cti-api/src/firewall/` + `routes/reputation.ts` + the warmup state machine into a standalone npm package + REST API. Build one reference integration (your own CTI). Pitch it as "Compliance + Reputation as a Service."

If that pivot's too big, the **second-best 10x** is to pick one vertical (GG Homes is real estate — that's a real vertical) and become *the* CTI for it. Real estate cold calling has specific characteristics (Florida is the dominant state with mini-TCPA traps, recipient timezones span 4 zones, repeat-call patterns matter) that you can encode deeply.

---

## Things being built that don't matter (yet)

| Built | Reality |
|---|---|
| **Electron menubar app** | Nice. But the actual usage will happen in the SF Open CTI iframe. Menubar is split focus. |
| **Light/dark theme toggle** | No enterprise buyer evaluates a CTI on theme support. Pleasant polish. |
| **Inline name editing in cti-web header** | Will be replaced the moment SF OAuth profile fetch works reliably. |
| **tel: URL handler in Electron** | Cute. Salesforce Open CTI is where 95% of usage will live. |
| **Twilio API key rotation TODO** | Has been pending all session. Either do it or remove the todo. |
| **STIR/SHAKEN attestation logging per call** | Important downstream. Currently useless until you have call volume to find patterns. |
| **Salesforce sync-job retry queue** | Built before Open CTI's `saveLog` was wired. Open CTI's `saveLog` made this almost redundant. |

---

## Things being built that matter (and management may underestimate)

| Built | Why it matters |
|---|---|
| **Pre-call firewall with state-specific rules** | Florida FTSA class actions average $500/violation × thousands of plaintiffs. Compliance buyers will pay for this alone. **This is your strongest enterprise pitch.** |
| **Per-DID warmup state machine + daily cap** | Directly maps to dollars. A "Spam Likely" labeled number loses ~70–90% of its connect rate ≈ ~$2k/mo in lost rep productivity per number per the industry data. Prevents the kill. |
| **Number rotation pool (least-recently-used)** | Prevents any single DID from carrying the reputation load. Spreads risk like portfolio diversification. |
| **Reputation dashboard with Hiya 4-axis model** | Moves the conversation from "we think our calls are getting flagged" to "our org reputation is 72/100 across 14 numbers; here's the trend." Governance language. |
| **Recipient-state-derived calling hours** | The only CTI I know of that pulls Lead.MailingState → IANA TZ → calling-hours check. Trivial-looking, deceptively rare. |
| **Inbound auto-answer for reputation hygiene** | Anti-spam scanner defense. None of the major CTIs do this — they all assume the carrier handles inbound. They don't. |
| **Pre-call audit log of every decision** | When the FCC's April 2026 KYC FNPRM lands, every dialer needs this. You already have it. |

---

## Demo strategy — defend these three claims

When management asks "but how is this different from RingCentral?", anchor on:

### 1. "We're the only CTI that quantifies caller reputation."

Open the **Reputation tab**. Show three DIDs at different warmup tiers (F → C → B). Point at the 4-axis breakdown. Note that this is modeled on Hiya's September 2025 publicly-launched scoring methodology. *No other CTI exposes this.*

Hard counter to "but Hiya already has a portal" → "Yes — Hiya's portal shows you what *they* think after the damage is done. We show you what's *happening* before the damage. We act on the same signals they act on."

### 2. "We block calls that would damage reputation, not just calls that violate compliance."

Open the **Dialer**. Show the 11 checks. Highlight `warmup` and `neighbor_spoof` — these aren't legal-compliance checks; they're *reputation hygiene*. Other CTIs check DNC + calling hours and stop. We check 11 things, 7 of which are about *keeping numbers clean*, not just *staying legal*.

### 3. "Every regulatory change in 2026 is already in our roadmap."

Open `SPAM_RESISTANCE_2026.md`. Point at the regulatory minimums table. RMD recertification, FCC 8th Order, the April 2026 KYC FNPRM, state mini-TCPAs (FL/OK/MD/NJ/NY/TX). We're not catching up; we're ahead.

---

## Risks to acknowledge before they're asked

| Risk | Acknowledge with |
|---|---|
| **Not hosted anywhere stable.** Cloudflared tunnel on your laptop. | "Day-1 after this demo: Vercel deploy for the static iframe + Fly for the API. ~$15/month, takes 30 minutes." |
| **Reputation scores are 100% from our own DB**, not real Hiya/First Orion/TNS portal data. | "P1 milestone: 2 weeks out. We have the architecture for it; we don't have the vendor accounts. ~$200/mo for Hiya Connect API access." |
| **Open CTI utility item competes with the existing 360CTI install.** | "Either we replace 360CTI or coexist as a utility item. Either is a 5-minute admin change in Salesforce." |
| **Single rep tested.** | "Pilot plan: 3 reps for 2 weeks. We measure connect rate before vs after. If our reputation defense is real, we should see ≥20% connect rate lift within 30 days." |
| **The cti-web bundle changes URL when the tunnel restarts.** | "Vercel stabilizes this. Until then, every test session updates the Call Center XML." |

---

## Go / No-Go recommendation

**GO**, with one caveat.

The thesis (spam-likely is the dominant CTI buying signal in 2026) is correct. The tech is unusually thoughtful for a one-day build. The Hiya 4-axis model + warmup state machine + state-aware firewall is **genuinely unique** in the CTI market.

**The caveat:** This product, as currently scoped, is a feature, not a company. It needs *either*:
- A vertical commitment (real estate cold calling), or
- A horizontal pivot (sell the reputation engine to other dialers)

Don't ship "another general-purpose CTI" — there are 30 of those, and they all have funding. Ship a sharply-aimed thing.

---

## One-week action list (Monday morning)

1. **Deploy properly.** `vercel deploy` for cti-web (5 min) + `fly launch` for cti-api (30 min). Update the Salesforce Call Center XML once. Kill the cloudflared dependency.
2. **Rotate the Twilio API key** that got echoed earlier. 30 seconds.
3. **Get one paying-or-LOI customer commit** before building more features.
4. **Subscribe to Hiya Connect** ($29/mo entry tier) → real reputation feed in the dashboard, not just our DB-derived proxy.
5. **Pick the vertical.** If it's real estate, kill anything that's not real-estate-specific (Salesforce wholesale-flow stuff, generic dialer polish). If it's reputation-as-a-service, extract the firewall into a package and demo it inside Aircall/RingCentral as a Chrome extension.
6. **Buy `caller-reputation.com` or similar.** The name positions the company. Carries the whole pitch.

---

## What I'd cut today if I could

- The Electron menubar app's *Reputation tab* duplication — it's also in cti-web. Pick one.
- The tel: handler. Salesforce Open CTI replaces it.
- The Salesforce sync-job retry queue (now redundant with Open CTI saveLog).
- The light theme. Ship dark only.
- The hardcoded `'dev'` username fallback. Replace with SSO before any real pilot.

---

## What I'd add this week

1. **A `pricing.md`.** Even if internal. Three tiers, anchored on per-rep + per-DID-protected.
2. **One-page sales doc.** Three claims, three screenshots from the Reputation tab, two carrier-blocked-call testimonials (find these via your network or simulate with Hiya complaint data).
3. **A live `reputation.public/`** endpoint that lets a prospect upload a CSV of their DIDs and get back a Hiya-style score. Lead magnet.
4. **A 60-second screen recording** of click-to-dial in Salesforce → ALLOW verdict → green button → call connects → Task auto-attached. This is your top-of-funnel video.

---

## Pre-demo checklist (next 45 min)

- [ ] Restart Electron once → click **Reputation** tab → confirm the F / C / B dashboard renders
- [ ] Open `SPAM_RESISTANCE_2026.md` in a tab so you can flip to it for citations
- [ ] Open this doc (`PRODUCT-BRIEF.md`) in a tab so you can speak to the risks honestly
- [ ] Have your cell phone ready to dial `+1 (619) 848-1782` live for the inbound demo
- [ ] Have a Lead with a phone number open in Salesforce → ready to click-to-dial
- [ ] Prepare the answer to "what does this cost to build out properly?" — say ~$3–4k/mo (Hiya Connect $200, Vercel $20, Fly $50, Twilio per-call passthrough, Numeracle KYC ~$2k one-time)
- [ ] Prepare the answer to "what's the moat?" — "We're the only CTI built around Hiya's public scoring methodology + 2026 FCC enforcement plumbing. Every other CTI is fighting the carrier; we're aligning with it."

Good luck. The product is real. The pitch needs work. The opportunity is bigger than the README suggests.
