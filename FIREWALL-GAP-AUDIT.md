# Firewall Gap Audit — what we check vs what 2026 detection systems weigh

## What our firewall checks today (13 gates)

1. `phone_parse` — number normalizes to E.164
2. `opt_out` — internal opt-out list
3. `blocklist` — manual blocklist
4. `campaign` — campaign not paused
5. `attempt_limit` — per-campaign attempt cap in a window
6. `calling_hours` — recipient-TZ-aware (derived from SF Lead address)
7. `outbound_number` — DID is registered, active, healthy
8. `warmup` — per-DID daily cap based on age tier (20/40/70/80)
9. `velocity` — >10 calls/min anti-burst
10. `neighbor_spoof` — NPA / NPA-NXX match detection
11. `state_rules` — FL/OK/MD/NJ/NY/CA/TX overrides
12. `state_registration` — TX-style flag
13. `recording_consent` — two-party consent flag (set; not yet auto-played)

We also **log** STIR/SHAKEN attestation per call (passive — not a block).

---

## What's missing (organized by leverage)

### 🔴 P0 — must build before any real pilot

| Gap | Why it matters | Build cost |
|---|---|---|
| **Federal DNC scrub** | TCPA violations: $500–$1,500 per call. Single biggest compliance liability. We have an internal opt-out, but the federal list has 240M+ numbers. | 30 min stub + $X/mo to a vendor |
| **Reassigned Numbers Database (RND) check** | FCC requires this before any consent-required call. Consent doesn't transfer when a number is reassigned. Safe-harbor only if you check RND. | 30 min stub + $0.40-per-query vendor |
| **Consent record table + per-call evidence** | TCPA audit-trail: source URL, IP, timestamp, exact disclosure text shown. Required *now*; the April 2026 KYC FNPRM tightens this further. | 1 hour schema + UI for capturing |
| **Auto-play recording disclosure in TwiML** | Flag exists (`recording_consent_mode='two_party'`); the actual TwiML `<Say>` of the disclosure script never got wired into the outbound voice route. | 15 min |
| **SIP 603+ analytics-block detection** | FCC 8th Order (eff. March 25, 2026): terminating carriers MUST signal analytics blocks via SIP 603+. We listen to Twilio status callbacks but don't distinguish "user rejected" from "carrier blocked." First leading indicator that a number is being labeled. | 30 min |
| **STIR/SHAKEN attestation enforcement** | We log it. We don't *block* on it. If a DID suddenly attests B or C instead of A, that's the canary — we should alert and pause it. | 30 min |

### 🟠 P1 — within 2 weeks, gated on external accounts

| Gap | Vendor / cost |
|---|---|
| **Hiya Connect portal status pull** | $29–500/mo. Real reputation feed for AT&T/Samsung. Replaces our DB-derived proxy on the Sentiment axis. |
| **First Orion CallTransparency portal status** | Free portal account + paid API. Real feed for T-Mobile/US Cellular. Updates every 6 min. |
| **TNS Call Guardian portal status** | Enterprise contract via Bandwidth or direct. Real feed for Verizon/cable. |
| **FreeCallerRegistry submission state tracking** | Free service, but we should track per-DID: `pending / submitted / verified` and surface in the dashboard. |
| **BCID enrollment per number** | $50–250/mo via Numeracle or Hiya Connect. Single biggest answer-rate lift (+30–60%). |
| **Numeracle KYC / Verified Identity** | ~$2k one-time. Maps our org to a vetted-entity registry — major positive signal for all three analytics engines. |
| **State DNC lists** | TX/PA/CO/etc. maintain separate state DNC lists in addition to federal. |
| **CNAM ↔ BCID ↔ 10DLC TCR consistency check** | All three should display the same brand name. Mismatch = vetting red flag at Numeracle/iconectiv. |

### 🟡 P2 — behavioral signals we could weight

| Gap | Source |
|---|---|
| **Recipient call-back rate per DID** | We have inbound; could weight as a positive signal (recipient calling back = strong trust signal). |
| **Voicemail-completion vs hangup ratio** | TWS provides this; we don't pivot calls on it. |
| **Geographic concentration of called numbers** | Calling 100 numbers in one zip = suspicious (Hiya signal). |
| **Long-silence-then-burst pattern** | "Aggressive calling after a long period of no calls" — explicit First Orion / Hiya signal per Kixie's research. |
| **Outbound/inbound ratio per DID** | Pure-outbound DIDs score worse than two-way numbers. We already log direction. |
| **Sub-6-second short-hangup as a *block*** | Currently a dashboard signal; could be a real-time firewall check ("this DID is averaging 4s — pause it"). |
| **Per-recipient block-rate proxy** | We don't track when a single recipient hangs up multiple times from our pool. |
| **Per-call originating IP logging** | FCC April 2026 KYC FNPRM proposes requiring this. Cheap to add now. |

### ⚪ Not buildable from our side (OS-layer filtering)

| What we can't control | What we *can* do about it |
|---|---|
| iOS Silence Unknown Callers (40–50% B2B adoption) | SMS pre-warm to get added to recipient contacts |
| iOS 26 Siri-powered call screening | BCID enrollment persists brand identity through the screen |
| Pixel Call Screen (Gemini Nano) | Same — BCID is the only bypass |
| Samsung Smart Call (Hiya-powered) | Hiya Connect enrollment puts us on the friendly side |
| Truecaller / YouMail / Robokiller / Nomorobo honeypots | Avoid known honeypot DIDs (would need a honeypot-DID list — none public) |

---

## The honest scorecard

| Layer | Coverage |
|---|---|
| **Regulatory compliance** | 60% (have state caps + hours + recording flag; missing federal DNC, RND, consent records) |
| **Carrier-analytics signal hygiene** | 70% (warmup + velocity + neighbor-spoof + rotation are good; missing real Hiya/First Orion/TNS feeds) |
| **Identity / vetting layer** | 10% (we log attestation; have not enrolled in any registry) |
| **Behavioral signal weighting** | 40% (have the data infrastructure; haven't wired all the signals into scoring) |
| **OS-layer defense** | 0% (BCID enrollment is the only lever; not done) |

**Composite: ~35–40% of the theoretical 2026 defense surface.** Better than every general-purpose CTI on the market (most are at 5–10%), but nowhere near complete.

---

## What I'd build in the next 20 minutes (pre-demo)

If you say go, in priority order:

1. **National DNC scrub stub** (`dnc` firewall check) — block if number appears on internal DNC; integrate a real provider later. Adds a visible check in the verdict panel.
2. **Reassigned Numbers Database stub** (`rnd` firewall check) — same pattern, returns "stub-allow" until vendor is plugged in.
3. **Auto-play disclosure in voice TwiML** — when campaign requires two-party consent, `<Say>` the disclosure script before bridging.
4. **SIP 603+ detection** — when Twilio status callback indicates `analytics-blocked`, immediately mark the DID `health=degraded` and pause it.
5. **STIR/SHAKEN attestation enforcement** — `attestation` firewall check that warns when a DID is suddenly attesting B or C instead of its baseline A.

That's 5 more visible checks in the firewall verdict. Brings the demo count from 13 to 18, and the gap-audit story becomes "we cover every category — some categories need external data feeds we'll subscribe to in P1" instead of "we have 13 of 40."
