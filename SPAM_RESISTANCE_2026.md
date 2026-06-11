# Spam-Likely Resistance Plan — 2026

## TL;DR — the landscape, in four facts

1. **There is no longer a single "carrier algorithm."** US carrier labeling is sourced from three private analytics engines (Hiya for AT&T/Samsung, First Orion for T-Mobile/US Cellular, TNS Call Guardian for Verizon/cable). They share inputs but score differently. Hiya in September 2025 publicly launched a **"Caller Reputation credit score"** with four axes: **Maturity, Connection, Engagement, Sentiment.** That model is now the de facto template the whole industry follows.
2. **A-level STIR/SHAKEN attestation is now table stakes, not a feature.** 93% of Tier-1↔Tier-1 traffic in 2025 was A-attested. C-attestation calls are being silently blocked by terminating carriers under the FCC 8th Order. B-attestation calls don't display any verified-caller indicator. **No A = no clean delivery.**
3. **Phone OS itself is now an active filter, not a passive renderer of the carrier label.** iOS Silence Unknown Callers (~40–50% B2B adoption, 60–70% C-suite), iOS 26 Siri-powered call screening (Apple auto-answers and transcribes before ringing), and Pixel Call Screen on Gemini Nano all block calls **before the user is even shown a ring**. "Spam Likely" carrier-labeled calls now bypass iOS Live Voicemail entirely — they can't even leave a screened message.
4. **The kill threshold for a fresh DID is much lower than people think.** A brand-new number dialing >100 outbound calls on day one with <5% answer rate and <6-second average duration gets tagged "Spam Likely" within **24–72 hours**, sometimes within hours on T-Mobile (First Orion updates labels every six minutes).

---

## The three layers of filtering (2026)

```
            ┌─────────────────────────────────────────────────┐
            │  Layer 3: Phone OS (iOS 26 Screening, Pixel)    │  → Auto-decline before ring
            ├─────────────────────────────────────────────────┤
            │  Layer 2: Carrier analytics                     │  → "Spam Likely" / "Scam Likely" label
            │    Hiya · First Orion · TNS Call Guardian       │
            ├─────────────────────────────────────────────────┤
            │  Layer 1: Network / regulatory                  │  → C-attestation = blocked
            │    STIR/SHAKEN, RMD, mandatory blocking         │
            └─────────────────────────────────────────────────┘
                            ↑
                You start here. Get past all three.
```

---

## The full signal panel (what detectors are actually measuring)

| Signal | Weight | What "bad" looks like |
|---|---|---|
| **Maturity** (DID age + history) | Heavy | Fresh DID + Day-1 burst = automatic flag. Hiya scores rotating DIDs explicitly worse than aged ones. |
| **Connection** (answer rate) | Heavy | <5% = danger zone. Branded calling lifts this from ~5% to ~25–35%. |
| **Engagement** (avg call duration after answer) | Heavy | <6s avg = robocall fingerprint. |
| **Sentiment** (block + spam-report rate) | Heavy | 8–15 user blocks/24h from distinct recipients = labeling starts. |
| **STIR/SHAKEN attestation** | Heavy | C-attested = silently blocked. B = no UI checkmark. A required. |
| **Daily call volume** | Medium | >70/day = soft trigger. >100 = flag risk within days. >200 = near-certain label in 24–72h. |
| **Call velocity** | Medium | >10 calls/min from one DID flags as autodialer. |
| **Repeat-call frequency per recipient** | Medium | >3 dials/24h to same number triggers nuisance pattern. |
| **Neighbor-spoofing detection** (NPA or NPA-NXX matches recipient) | Medium | 74% of robocalls used local-spoofing in 2025; Hiya now penalizes tight area-code matching. |
| **Time-of-day** (calls outside 9am–8pm recipient local) | Medium | Off-hours bursts = penalty. |
| **Outbound/inbound ratio** | Light | Pure-outbound DIDs flagged more than two-way numbers. |
| **Recipient call-back rate** | Light (positive) | Recipients calling back is a strong positive signal. |
| **10DLC SMS reputation on the same DID** | Light | Bad SMS Trust Score doesn't formally feed voice scoring but shares KYC plumbing. |
| **Recycled-DID prior reputation** | Light | Recycled DIDs inherit the previous owner's reputation. ~45–90 day quarantine after release. |
| **KYC / vetted-entity registry** | Positive signal | Numeracle Verified Identity, BCID enrollment, FreeCallerRegistry — all explicitly used as positive inputs. |

---

## The quantified kill thresholds (memorize these)

| Threshold | Outcome |
|---|---|
| Fresh DID + 100+ dials day 1 + <5% answer + <6s avg | Spam Likely within 24–72h |
| Any DID at >200 dials/day | Spam Likely within hours on T-Mobile (First Orion 6-min refresh) |
| >10 calls/min from one DID | Autodialer velocity flag |
| <6s average duration | Robocall fingerprint |
| Complaint rate >0.1% (1 per 1,000) | Reputation degradation begins |
| Complaint rate >0.3% | Active labeling |
| 8–15 user blocks/24h from distinct numbers | Labeling on most engines |
| Calls outside 9am–8pm recipient local | Per-call penalty |
| NPA or NPA-NXX match between caller and recipient | Neighbor-spoofing penalty (even for legit local presence) |

**Warm-up curve that doesn't trigger labeling:**
- Week 1: 15–20 dials/day
- Week 2: 25–40 dials/day
- Week 3: 50–70 dials/day
- Week 4+: plateau at 70–80 dials/day per DID

---

## The 2026 regulatory minimums

| Item | Status | Action |
|---|---|---|
| **STIR/SHAKEN A-attestation** | Required for clean delivery | Twilio Trust Hub Business Profile or Telnyx Verified Caller; KYC 24–72h |
| **Robocall Mitigation Database (RMD)** | Required for any carrier holding numbers | Recertify by March 1 each year |
| **CTIA Branded Calling ID (BCID)** | Optional but +30–60% answer rate | Numeracle / First Orion ENGAGE / Hiya Connect |
| **FreeCallerRegistry** | Free, pushes to Hiya/First Orion/TNS at once | Register every DID before first dial |
| **All-party recording consent disclosure** | 12 all-party states (CA, CT, DE, FL, IL, MD, MA, MI, MT, NH, PA, WA + NV) | Auto-play disclosure as first sentence |
| **State mini-TCPA caps** | FL/OK/MD/NJ: 3 calls/24h per recipient per subject. NY: $20k/violation. TX: registration + bond | Per-state attempt limits |
| **FCC SIP 603+ telemetry** | Effective March 25, 2026 | Distinguish carrier analytics blocks from user rejects |
| **FCC enhanced KYC FNPRM** | Proposed April 30, 2026 | Log originating IP per call + intended-use category |
| **DNC** (federal + state + per-company) | Existing | Weekly federal scrub; honor STOP immediately |

---

## Detection systems map (US, 2026)

| Carrier | Primary Analytics Engine |
|---|---|
| T-Mobile / Metro / Mint | **First Orion** (Scam Shield) — updates every 6 minutes |
| AT&T / Cricket | **Hiya** (ActiveArmor) |
| Verizon / TracFone / Visible | **TNS Call Guardian** (+ Hiya for Call Filter Plus) |
| US Cellular | First Orion |
| Boost / Dish | TNS |
| Comcast / Charter (cable voice) | TNS |
| Samsung native Smart Call | Hiya |

**Third-party (OTT) labelers:** Truecaller (~450M users), YouMail (300k honeypot DIDs), Robokiller (audio fingerprint), Nomorobo (~300k honeypot DIDs).

**Single registration point:** [FreeCallerRegistry.com](https://freecallerregistry.com/fcr/) — operated by AT&T/Verizon/T-Mobile jointly. Pushes to Hiya/TNS/First Orion in one submission. Free.

---

## Engineering plan (priority-ordered)

### P0 — highest leverage, lowest cost to build

1. **Per-DID daily velocity cap + warmup state machine**
2. **Hourly velocity cap (>10/min anti-burst)**
3. **Number rotation pool with round-robin distribution**
4. **Neighbor-spoofing detector**
5. **Sub-6-second call detection + rep coaching**
6. **STIR/SHAKEN attestation tracking per call**
7. **State-specific calling rules (FL/OK/MD/NJ/NY/TX)**
8. **Auto-play all-party recording disclosure**

### P1 — within 2 weeks

9. FreeCallerRegistry submission helper
10. Reputation health dashboard (Hiya-style 4-axis score)
11. 10DLC ↔ voice consistency check
12. Pre-call SMS warming (opt-in per campaign)
13. SIP 603+ analytics-block detection

### P2 — within a month

14. Numeracle / Voice Integrity Services integration
15. BCID enrollment workflow
16. National DNC scrub provider (pluggable)
17. Recycled-DID prior-reputation check
18. Audit-ready evidence export

---

## External actions (can't be automated by us)

1. **A-attestation on every DID through Twilio Trust Hub** — KYC ~48h
2. **Register every DID with FreeCallerRegistry** — free, ~4 business days
3. **Enroll in CTIA Branded Calling ID** — Numeracle / Hiya Connect / First Orion ENGAGE. ~$50–250/mo + ~$0.05/call. Biggest answer-rate lift available.
4. **File RMD certification** (recertify by March 1 each year)
5. **10DLC TCR campaign registration** with the same brand name as voice CNAM/BCID
6. **Texas registration + bond** before any sales calls into Texas

---

## Sources

- Hiya: [Caller Reputation launch (Sept 2025)](https://www.businesswire.com/news/home/20250930624483/en/Hiya-Launches-Caller-Reputation-the-First-Credit-Score-for-Business-Calls), [scoring axes documentation](https://hiyabusiness.zendesk.com/hc/en-us/articles/45165462489747-Caller-Reputation), [iOS 26 call screening](https://blog.hiya.com/what-you-need-to-know-about-apples-ios-26-call-screening)
- First Orion: [Scam Shield 6-min refresh](https://firstorion.com/t-mobile-has-blocked-over-a-billion-scam-calls-and-now-industry-leading-tech-keeps-customers-even-safer/), [INFORM pricing](https://firstorion.com/inform-pricing)
- TNS: [2026 Robocall Report](https://tnsi.com/resource/com/tns-2026-robocall-report-going-further-than-stir-shaken-blog/), [Verizon Branded Calling case study](https://tnsi.com/resource/com/how-verizon-protected-its-reputation-with-branded-calling/)
- FCC: [Call Branding FNPRM Oct 2025](https://docs.fcc.gov/public/attachments/DOC-415059A1.pdf), [RMD strengthening Jan 2026](https://www.federalregister.gov/documents/2026/01/06/2026-00010/improving-the-effectiveness-of-the-robocall-mitigation-database-cores-registration-system), [8th Call Blocking Order](https://www.federalregister.gov/documents/2025/03/24/2025-04811/advanced-methods-to-target-and-eliminate-unlawful-robocalls)
- CTIA Branded Calling ID: [official site](https://brandedcallingid.com/), [TransNexus whitepaper](https://transnexus.com/whitepapers/branded-calling-id/)
- iOS 26 BCID compatibility: [Numeracle testing](https://www.numeracle.com/insights/ios-26-bcid)
- iOS adoption: [Nooks data on call screening](https://www.nooks.ai/blog-posts/early-data-on-ios-call-screening-what-it-means-for-outbound)
- State mini-TCPAs: [Manatt roundup](https://www.manatt.com/insights/newsletters/tcpa-connect/state-mini-tcpa-telemarketing-laws-continue-to-p)
- Recording consent: [Recording Law 2026 guide](https://www.recordinglaw.com/party-two-party-consent-states/)
- Quantified thresholds: [BatchDialer 2026 guide](https://batchdialer.com/blog/how-to-increase-call-answer-rates-in-2026-spam-labels-local-presence-strategies), [Nomorobo area-code spoofing surge](https://www.nomorobo.com/area-code-spoofing-surges-2025/)
</content>
