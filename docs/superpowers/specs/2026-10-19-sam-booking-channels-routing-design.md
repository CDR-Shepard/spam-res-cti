# Sam books with the right rep, and follows up by text, email and voicemail

Status: design, 2026-10-19. Owner decisions from the conversation are stated as decisions; my calls are marked
**(my call)** for the owner to check.

## Why
Sam, the outbound AI caller (a woman; voice: ElevenLabs Siren), calls sellers who are already in touch with GG Homes.
Today she can only call, every appointment she books goes on one person's calendar (Grant Golden), she does not know
whether the seller already had a consultation, and a seller who stops answering the phone is simply retried by phone.
The owner wants Sam to book the way the team books — the right rep, at the right hours, on a route that makes sense —
and to stay on top of every seller across calls, texts, emails and voicemails until there is an outcome.

## Goals
1. Before a call, know whether the seller has had a consultation before, and book either way (Part A).
2. Give each appointment to the right rep at a valid time, using real drive times (Part B).
3. Reach and answer sellers by text and email, leave voicemails in Sam's own voice, and keep one conversation per
   seller across all of it, with a follow-up rhythm that only stops on an outcome (Part C).

## Non-goals
- Cold outreach. Everyone Sam texts or emails is already in touch with GG Homes (owner, 2026-10-19).
- Ringless voicemail (going straight to voicemail without the phone ringing). "Voicemail" here means the message Sam
  leaves when her call reaches voicemail. **(my call — my reading of "AI voicemail drop")**
- Changing who Sam calls or how call plans are approved: the existing outreach-web flow (Salesforce query → research →
  per-lead plan → approval → Sam calls) stays.

## Anti-goals (would make this a failure even if it "works")
- Double-booking a rep, or booking a time a rep cannot physically drive to. (The one exception is high priority:
  Grant is booked at the seller's time even over his calendar — owner decision.)
- Giving an appointment to a rep outside their region.
- Any touch after a seller says stop, or after they book.
- Sam saying she is a person.
- Seller details (names, numbers, addresses, message text) in logs.

## Part A — Past consultations (owner items 1 and 2)
- **What counts:** a Salesforce Event whose Subject contains "Consultation" (today: "Property Consultation" and
  "Phone Consultation"), linked to the seller's Opportunity (WhatId) or their Lead/Contact (WhoId). Past = it started
  before now. Research already reads these Events (outreach-api `research/activity.ts`); this makes the answer explicit
  and puts it in front of Sam: had one before yes/no, its date, and who ran it.
- **None before:** Sam tries to book, as today.
- **One before:** Sam brings up the earlier visit herself ("I see we came out back in March…") and asks what has
  changed, then still books. The new Event's Description starts with the reason in the seller's words, e.g.
  "Previous consultation: Mar 12 with Blake Kossuth. What changed: seller says it didn't work out last time, now they
  really want to sell." (owner: "yep thats good")
- **One already booked in the future:** Sam does not book a second; she confirms the existing one (day, time, who)
  and the touch ends as already booked. (my guess in the conversation; owner agreed)

## Part B — Who gets the appointment, and when (owner item 4)
**Regions** (by the property's county). Salesforce has no County field (checked 2026-10-19), so the county comes from
geocoding the property address (Google Geocoding API, same key); if it can't be found, the seller is treated as outside
the regions. **(my call)**
| Region | Counties | Reps | Start times (Pacific) |
|---|---|---|---|
| LA | Los Angeles, Orange, Riverside, San Bernardino | Chance Lanier, Blake Kossuth | 9 AM, 11 AM, 1 PM, 3 PM, 5 PM, 7 PM (7 PM latest start) |
| SD | San Diego | Seth Boisvert, Thomas Wilkinson | on the hour, 9 AM–4 PM (done by 5 PM) |

- A consultation lasts **1 hour**.
- **In person first.** Sam offers an in-person Property Consultation. A Phone Consultation is offered only when the
  seller doesn't want anyone coming out. Phone consultations go to the same region's reps at the same start times.
- **Choosing the rep (in person):** for each candidate time, for each of the region's two reps: drive time from where
  that rep will be just before (the Location of their previous Event that day, or the office if none) to the property,
  and from the property to their next Event that day (if any). A rep can take the slot only if both drives fit
  (previous end + drive ≤ start; end + drive ≤ next start) and nothing on their calendar overlaps. Among reps who can,
  the shorter drive in wins. Tie → fewer appointments that week. **(my call: the tie rule and checking the drive to the
  next appointment too)**
- **Calendars:** Salesforce Events are the reps' calendars (the four reps own 250–300 consultation Events each in the
  last 90 days). About 94 % of past Property Consultations have a street address in Location; an Event whose Location
  is not a usable address counts as busy time, and the rep's position around it is taken as the office. **(my call)**
- **Office** (the starting point when a rep has nothing earlier that day): 18872 MacArthur Blvd #220, Irvine, CA 92612,
  for all four reps. (owner gave the address; applying it to all four is **my call**)
- **Phone consultations** need no drive: whichever of the region's reps is free; tie → fewer appointments that day.
  **(my call)**
- **Drive times** come from a routes service with traffic for that time of day (Google Maps Routes API, route matrix).
  If it is unavailable, fall back to a straight-line estimate with a generous speed so booking never stops.
  **(my call)**
- **Days:** the weekdays already set in the booking settings. **(my call: no new day rules)**
- **Outside the five counties:** no appointment; Sam offers a call back from the team and the seller is flagged
  (Part C). **(my call)**
- **High priority** (wants to sell ASAP, or an urgent situation such as a foreclosure or auction date — Sam judges
  on the call): the appointment goes to **Grant Golden** regardless of his calendar, Subject
  **"High Priority Property Consultation"**. Time: whatever the seller asks for; if they don't ask, Sam offers the
  earliest time on the next business day, from 9 AM. (owner; 9 AM start is **my call**) Any county, in person; a
  requested time must be at least 2 hours away and between 8 AM and 8 PM, weekends allowed. **(my call)**
- The Event is created the way it is today (outreach-api write-back on the Opportunity), owned by the chosen rep,
  with the property address in Location — owning the Event is how reps see their appointments today. The
  Opportunity's owner is not changed. **(my call)**

## Part C — Texts, email, voicemail, and staying on top of it (owner item 3)
**Texts — iMessage through BlueBubbles.** The owner sets up a BlueBubbles server on a Mac signed into GG Homes' Apple
ID. The team texts sellers from the same Apple ID too (owner) — see "Sharing a seller with the team" below. The platform sends through its API and receives every incoming message through its webhook; an incoming text is
matched to the seller by phone number. Sam writes outgoing texts and answers replies herself. The existing planner
rules for texts stay: mobile numbers only, no texts to FL/OK/WA/MD without the consent box, texting hours. No "reply
STOP" footer (owner, earlier), but any opt-out reply ("stop", "don't text me", etc.) stops every channel for that
seller.

**Email — Resend, on rethinkre.team.** Sent through Resend (already verified for sending on rethinkre.team) from an
address such as sam@rethinkre.team **(my call on the name)**. Replies are directed (Reply-To) to an address on a
receiving subdomain (e.g. reply.rethinkre.team, its MX pointed at Resend), so they reach the platform by webhook without
touching the team's Google inboxes; Sam answers in the same thread. Commercial email still needs an opt-out line and the
office postal address in every email (CAN-SPAM); an opt-out stops every channel. Resend's rules: complaints must stay
under 0.08 % — fine for sellers already in touch.

**Voicemail in Sam's voice.** Today a reached voicemail gets the message read by Twilio's stock Amazon voice
("Polly.Joanna-Neural", cti-api `ai-voice/twilio.ts`). Instead, the same per-seller message (first name, street) is
rendered in Siren while the phone rings and played after the beep. If rendering fails, the stock voice reads it, as now.

**One conversation per seller.** Calls (transcripts), texts, emails and voicemails go into one timeline per seller.
Sam gets the timeline at every touch and reply, so she never repeats herself or forgets what the seller said. Each touch
is also logged to Salesforce the way calls are today. **(my call: same logging style as calls)**

**Approval:** approving a seller for Sam in outreach-web covers the whole follow-up — every call, text and email for the
year — with no re-approval (owner). (Today a call plan is re-checked when Salesforce activity changes after research;
for enrolled sellers that check pauses Sam as below instead of sending the seller back for approval.)

**Sharing a seller with the team** (owner: reps can take over, give back, or Sam takes it back when it goes quiet):
- **A rep working the seller → Sam backs off** until the rep is done (owner). A rep is working the seller when there is
  a human touch: a CTI call, a Salesforce Task or Event by a person, an email logged by a person, or a text a person
  sends from the shared iMessage account (a message from the account that the platform did not send).
- **Take over / give back:** on the tracking page, "Take over" pauses Sam for that seller and "Give back to Sam" resumes
  her. A person texting the seller from the shared account takes over automatically.
- **Sam takes it back** when the seller has had no human touch and no message in either direction for **7 days**
  **(my call on 7 days)**, then resumes the rhythm where it left off and notes it on the timeline. Sam never sends into
  a thread a person has taken over.

**Follow-up rhythm** (owner: "ok great do it"):
- First two weeks: Day 1 call (voicemail if no answer) + text; Day 3 email; Day 5 call; Day 8 text; Day 11 call;
  Day 14 email. Never more than one touch a day except Day 1.
- Next month: one touch a week, rotating text, call, email.
- Then: a monthly check-in for a year by text or email, with a call every three months.
- Every touch still passes the planner's existing rules (hours, consent, suppression), which can delay or skip it.
- **Stops everywhere:** booked; not interested; asked to stop; wrong number or bounced email (that channel only if
  another still works **(my call)**).
- **"Not now, try me in March":** Sam records the date, goes quiet, and picks up then.

**Saying she is an AI:** texts and emails introduce Sam as GG Homes' AI assistant, as her calls and voicemails already
do (California requires bots to disclose in online messages meant to sell). The owner can change the wording in the
editable prompts, but Sam never claims to be a person. **(my call)**

**Texts to Sam's calling numbers:** they keep going to the reps as today; Sam's own texts come from iMessage, so
replies to them come back there. **(my call)**

**Flags for a person (my call):** Sam answers on her own, but flags the seller for the team (and tells the seller
someone will follow up) when they: ask for an offer or price, are angry or threatening, mention an attorney or legal
action, say they are not the owner, or say anything Sam isn't sure how to handle.

**Tracking page (my call):** in outreach-web, every seller in follow-up with their last touch, next touch and channel,
status (talking / quiet / booked / stopped / later), and flags; opening one shows the whole timeline.

## Setup the owner does (secrets go in Railway, never in chat)
- A Google Maps Platform API key with the Routes API and Geocoding API enabled.
- A Resend API key, plus DNS for the receiving subdomain (MX to Resend).
- The BlueBubbles Mac (Apple ID signed in, iPhone text forwarding on for green-bubble numbers) and its server URL and
  password.

## Build order (each its own plan, built in its own session; each ships on its own)
1. Parts A + B: past consultations, regions, rep routing with drive times, phone fallback, high priority to Grant.
2. Voicemail in Sam's voice.
3. Email through Resend, and the per-seller conversation timeline.
4. Texts through BlueBubbles.
5. The follow-up rhythm across channels, flags for a person, and the tracking page.

## Left to the builder
Data model and table names; how slots for the two reps are computed and cached per trigger; how the routes calls are
batched; where the timeline lives (outreach-api vs cti-api); webhook security for BlueBubbles and Resend (signatures /
shared secret); retries and idempotency of sends; the exact Salesforce logging fields; tests.
