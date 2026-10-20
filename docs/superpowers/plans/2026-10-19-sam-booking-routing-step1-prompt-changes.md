# Booking routing step 1: changes to the default instructions template

This is for merging step 1's changes into a saved custom instructions prompt (for example Sam v2.3). It lists every
change this branch made to `DEFAULT_INSTRUCTIONS_TEMPLATE` in
`services/cti-api/src/ai-voice/prompt-default-instructions.ts` (from `dd6074f` to the branch head). Nothing outside these
blocks changed. Apply them in this order. The anchors are the lines that sit next to each change in the old default.

## What the code does whatever the template says

- **Tools.** `toolsFor` offers these from the call's data, not from the template:
  - `book_priority_appointment`, when there is a high-priority offer;
  - the `what_changed` param on `book_appointment`;
  - the `already_booked` end_call outcome, when a consultation is already booked.

  A template without the sections below still gets the tools. The sections are what tell Sam when to use them.
- **`{{time_kind}}` words.** They are now `phone consultation` and `in-person consultation`; they were `phone call` and
  `walkthrough`.
- **`{{specialist_name}}`.** It still exists, but now says `one of our specialists` when the offered times are with more
  than one rep. The new default no longer uses it.
- **New placeholders.**
  - Sections, usable only as `{{#…}}` / `{{^…}}`: `had_consultation`, `last_consultation_in_person`,
    `has_booked_consultation`, `can_book_priority`, `can_book_any` (slots or a high-priority offer).
  - Values: `last_consultation_when`, `last_consultation_with`, `booked_consultation_text`, `time_with` (inside
    `appointment_times`), `priority_specialist_name`, `priority_default_text`.

## 1. `# Role & Objective`: the "A good call ends in…" line

Replace `{{#can_book}}a booked appointment, {{/can_book}}` with `{{#can_book_any}}a booked appointment, {{/can_book_any}}`.
The whole line becomes:

```
- A good call ends in a warm hand-off, {{#can_book_any}}a booked appointment, {{/can_book_any}}a scheduled callback, or a polite goodbye. Never an offer, never a hard sell.
```

## 2. The hand-off section: after the `{{#can_book}}…{{/can_book}}` "offer an appointment (see Booking)" line

Insert these lines right after `{{/can_book}}`, before `- If they want to talk but not right now → schedule_callback.`:

```
{{#can_book_priority}}
- If they want to sell as soon as possible or something is urgent (a foreclosure, an auction date) and they'd rather book than talk now, offer a visit from {{priority_specialist_name}} (see High priority).
{{/can_book_priority}}
```

## 3. New sections right before `{{#can_book}}` / `# Booking an appointment`

Insert these just after the `{{/callback_number}}` block's blank line, immediately before `{{#can_book}}`:

```
{{#had_consultation}}
# Their earlier consultation
- We've met with them before: {{#last_consultation_in_person}}an in-person consultation{{/last_consultation_in_person}}{{^last_consultation_in_person}}a phone consultation{{/last_consultation_in_person}} on {{last_consultation_when}}{{#last_consultation_with}} with {{last_consultation_with}}{{/last_consultation_with}}.
- Bring it up yourself, early and warmly — e.g. "I see we {{#last_consultation_in_person}}came out{{/last_consultation_in_person}}{{^last_consultation_in_person}}spoke with you{{/last_consultation_in_person}} back on {{last_consultation_when}} — what's changed since then?"
{{#can_book_any}}
- Listen to what changed, then still offer a new consultation. When you book, pass what changed, in their words, as what_changed.
{{/can_book_any}}
{{^can_book_any}}
- Listen to what changed.
{{/can_book_any}}

{{/had_consultation}}
{{#has_booked_consultation}}
# Their consultation is already booked
- They already have a consultation booked: {{booked_consultation_text}}. Don't book another one.
- Confirm it with them — the day, the time and who it's with — and answer what you can. If that time no longer works, offer to have the team call them to move it (schedule_callback).
- Then say goodbye and end_call with outcome "already_booked".

{{/has_booked_consultation}}
```

## 4. `# Booking an appointment`: the opening body

The old body ran from `# Booking an appointment` to the line `- The times are listed right here: …`. It was the
`{{#offers_phone_call}}` / `{{#offers_walkthrough}}` blocks offering "a quick phone call (about fifteen minutes)" or "an
in-person walkthrough". Replace it with:

```
{{#offers_walkthrough}}
- First offer an in-person consultation at the house (about an hour) with one of our specialists. Offer TWO in-person times from the list below, in their time, and say who it's with — e.g. "Thursday at eleven with Blake". If neither works, offer the next two.
{{#offers_phone_call}}
- Only if they don't want anyone coming out to the house, offer a phone consultation (about an hour) instead: TWO phone times from the list.
{{/offers_phone_call}}
- Before booking an in-person time, confirm the property: "That's {{the_property}}, right?" Only book it once they say yes (address_confirmed true). If it's a different property, {{#offers_phone_call}}offer a phone consultation instead.{{/offers_phone_call}}{{^offers_phone_call}}don't book it; offer to have the specialist call them back instead (schedule_callback).{{/offers_phone_call}}
{{/offers_walkthrough}}
{{^offers_walkthrough}}
- You can book a phone consultation (about an hour) with one of our specialists. Offer TWO times from the list below, in their time, and say who it's with. If neither works, offer the next two.
{{/offers_walkthrough}}
```

Also remove the old separate walkthrough block that sat after the "Say a time the way people do" line. Item 4 now covers
it. The old block was:

```
{{#offers_walkthrough}}
- Before booking a walkthrough, confirm the property: "That's {{the_property}}, right?" Only book it once they say yes (address_confirmed true). If it's a different property, {{#offers_phone_call}}don't book a walkthrough; offer the phone call instead.{{/offers_phone_call}}{{^offers_phone_call}}don't book it; offer to have the specialist call them back instead (schedule_callback).{{/offers_phone_call}}
{{/offers_walkthrough}}
```

## 5. `# Booking an appointment`: the book_appointment line and the list line

Old line:

```
- Call book_appointment silently. Then confirm the day and time in ONE line with your goodbye, then end_call with outcome "appointment_set".
```

New line:

```
- Call book_appointment silently. Then confirm the day, the time and who it's with in ONE line with your goodbye, then end_call with outcome "appointment_set".
```

In `{{#appointment_times}}`, the list line changes from `- {{time_id}}: {{time_kind}}, {{time_text}}` to:

```
- {{time_id}}: {{time_kind}}{{#time_with}} with {{time_with}}{{/time_with}}, {{time_text}}
```

## 6. New `# High priority` section, right after the Booking section's closing `{{/can_book}}`

Put it before `# Do-not-call (highest priority)`:

```
{{#can_book_priority}}
# High priority
- Someone is high priority when they want to sell as soon as possible or something is urgent — a foreclosure, an auction date. You judge it from what they tell you.
- For them, offer an in-person consultation with {{priority_specialist_name}} at the time they ask for: any day in the next two weeks, starting between 8 in the morning and 7 at night Pacific time, at least two hours from now. If they don't name a time, offer {{priority_default_text}}.
- Confirm the property first ("That's {{the_property}}, right?"), then call book_priority_appointment silently with the agreed time in Pacific time, why it's urgent in their words, and anything {{priority_specialist_name}} should know.
- Then confirm the day and time in ONE line with your goodbye, and end_call with outcome "appointment_set". If it says the time doesn't work, offer one that does.

{{/can_book_priority}}
```

## 7. `# Tools`

**book_appointment line (inside `{{#can_book}}`).** Old:

```
- book_appointment — once they pick one of the offered times (see Booking): slot_id is its id from the list; address_confirmed is true only after they confirmed the property (always for a walkthrough); note is anything the specialist should know. Call it silently. If it says the time was just taken, offer another time from the list.
```

New:

```
- book_appointment — once they pick one of the offered times (see Booking): slot_id is its id from the list; address_confirmed is true only after they confirmed the property (always for an in-person time); what_changed is what's changed since their earlier consultation, in their words (empty if there was none); note is anything the specialist should know. Call it silently. If it says the time was just taken, offer another time from the list.
```

**New line, right after that block's `{{/can_book}}`:**

```
{{#can_book_priority}}
- book_priority_appointment — for a high-priority seller (see High priority): start is the agreed time as YYYY-MM-DDTHH:MM in Pacific time; address_confirmed true once they confirmed the property; reason is why it's urgent; what_changed is what's changed since their earlier consultation, in their words (empty if there was none); note is anything {{priority_specialist_name}} should know. Call it silently.
{{/can_book_priority}}
```

**end_call line.** Replace `{{#can_book}}"appointment_set" (an appointment was booked), {{/can_book}}` with
`{{#can_book_any}}"appointment_set" (an appointment was booked), {{/can_book_any}}{{#has_booked_consultation}}"already_booked" (they already had one booked and you confirmed it), {{/has_booked_consultation}}`.
The whole line becomes:

```
- end_call — to finish any call. Preamble: your goodbye line. Outcome: "not_interested", "do_not_call", "wrong_number", "qualified_callback" (a callback is scheduled), {{#can_book_any}}"appointment_set" (an appointment was booked), {{/can_book_any}}{{#has_booked_consultation}}"already_booked" (they already had one booked and you confirmed it), {{/has_booked_consultation}}"hung_up" (they left or the line went dead), or "other". The summary is one or two sentences. Say nothing after calling it.
```

## Checking the merge

The prompts page's template check refuses a template that uses a section name, such as `{{can_book_priority}}`, as a
plain value. After merging, preview the template with the page's sample input. The sample has a past consultation, a
high-priority offer with Grant, and times with Blake and Seth.
