# Sam's Booking Rules and Drive-Time Rep Routing (Step 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before each AI call, Sam knows the seller's past and upcoming consultations. Every time she offers belongs to the right regional rep, at a valid start time, checked against real drive times. An urgent seller is booked with Grant at the time they ask for.

**Architecture:**
- outreach-api still computes everything when it places the call and sends it in the signed trigger. The trigger now carries:
  - per-slot reps (`slots`, each with its own `specialistSfUserId` and `region`);
  - the consultation facts (`context.consultations`);
  - the high-priority offer (`priority`).
  cti-api renders, validates and stores. It never routes.
- New outreach-api modules under `src/appointments/`:
  - a Google Maps client (Geocoding + Routes `computeRouteMatrix`, cached in process, with a straight-line fallback);
  - region lookup by county;
  - a calendar read covering several reps at once;
  - the routing engine;
  - consultation facts;
  - the routed offer. It replaces today's single-owner offer.
- Sam gets new prompt placeholders and default instruction text for:
  - earlier and upcoming consultations;
  - in-person first, phone only when nobody may come out;
  - high priority.
  She also gets a `book_priority_appointment` tool and an `already_booked` call outcome.
- The write-back makes the Event as today, owned by the slot's rep. It changes three things:
  - a high-priority booking gets the Subject "High Priority Property Consultation";
  - the Description opens with the earlier consultation and what changed;
  - before writing, it re-checks that the rep can still drive there in time.

**Tech Stack:** TypeScript, zod (`packages/contracts`), Fastify + Drizzle (`services/outreach-api`, `services/cti-api`), React + react-query (`apps/outreach-web`), vitest. Google Geocoding API and Routes API over `fetch`, with no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-19-sam-booking-channels-routing-design.md` on branch `origin/feat/sam-booking-channels-routing`. Read it with `git show origin/feat/sam-booking-channels-routing:docs/superpowers/specs/2026-10-19-sam-booking-channels-routing-design.md`. This plan builds **Part A and Part B only**. Part C (texts, email, voicemail, follow-up rhythm, flags, tracking page) belongs to later steps.

## Decisions for the owner to confirm

These are calls the spec leaves open or that I made while planning. Each is easy to change before the build starts.
1. **Google cost.** Drive times use the Routes API with traffic (`TRAFFIC_AWARE`, the "Route Matrix Pro" price): $10 per 1,000 legs, after 5,000 free legs a month. They are computed when a call is placed, because the times travel with the call.
   - Expect about 15–40 legs per call placed, capped at 60. Legs repeated across retries are cached.
   - At 50 calls a day that comes to about **$150–400 a month**. Geocoding stays inside its free 10,000 a month.
   - Without traffic (`TRAFFIC_UNAWARE`) it costs about half, but drive times ignore rush hour.
2. **High priority stays inside the five counties.** I read the spec's "any county" as any of the five counties. That means either region can go to Grant. Outside the five counties, an urgent seller is treated like anyone else outside the regions: no appointment, Sam offers a callback.
3. **High-priority hours.** The requested start must be at 8 AM or later, and the hour must end by 8 PM, so the latest start is 7 PM. The start must be at least 2 hours away and on a quarter hour. Weekends are allowed.
4. **A phone consultation also lasts an hour.** The spec says a consultation lasts one hour, so Sam stops saying "about fifteen minutes".
5. **New call result "Already booked".** When the seller already has a consultation ahead, Sam confirms it and ends the call with this result. The touch is completed. There is no further AI call for that seller in this campaign and no write-back row. The usual call Task is still logged.
6. **The region table lives in the tenant's settings.** Its defaults come from the spec: counties, the four reps, the start times and the office. The AI calls card shows it read-only. Editing it in the UI is later work.
7. **The drive is checked again at write-back.** The check allows 15 minutes of slack. If the rep can no longer make it, the write-back uses today's "calendar was taken" path: the Opportunity goes to Followup and the rep gets a Task to call the seller.
8. **Need from you:**
   - (a) Before deploy, add `GOOGLE_MAPS_API_KEY` to the **outreach-api** service on Railway. Without it, no appointment times are offered at all; calls still go out.
   - (b) If you saved your own version of Sam's instructions on the Prompts page, it will not get the new booking text. After deploy, start a new version from the default.

## Global Constraints

- **Values from the spec, verbatim:**
  - LA region:
    - Counties: Los Angeles, Orange, Riverside, San Bernardino.
    - Reps: Chance Lanier `0055f000005qXn8AAE`, Blake Kossuth `0058X00000FA8tLQAT`.
    - Starts at 09:00, 11:00, 13:00, 15:00, 17:00 and 19:00 Pacific.
  - SD region:
    - County: San Diego.
    - Reps: Seth Boisvert `0055f000005qXVfAAM`, Thomas Wilkinson `0055f000005qYO6AAM`.
    - Starts every hour from 09:00 to 16:00 Pacific.
  - High-priority rep: Grant Golden `0058X00000Fsx39QAB`. He is the first active user on the existing `specialists` list, so no new setting is needed.
  - Office (every rep's starting point): `18872 MacArthur Blvd #220, Irvine, CA 92612`.
  - A consultation lasts **60 minutes**.
  - Subjects: `Property Consultation`, `Phone Consultation`, `High Priority Property Consultation`.
  - Zone: `America/Los_Angeles` for region times and for high priority.
- **Saved settings keep working.** `routing` is OPTIONAL in `AiCallBookingSettings`. A blob saved before this change must still parse. Otherwise `bookingSettings` falls back to the defaults, and the defaults have booking OFF.
- **Booking never stops a call.** Every offer path is wrapped so it never throws. A failure means fewer or no times, plus a note. The call still goes.
- **Seller data never reaches logs:**
  - addresses, Event Locations and Subjects;
  - names, phone numbers;
  - Google request URLs and the API key.
  Log only ids, counts, note codes and error codes. Google's Geocoding API takes the key as a query parameter, so never log a request URL.
- **Salesforce is read-only from tests and from me.** Tests use fake clients. The app writes only through the existing write-back.
- **No real calls, texts or emails.** Tests and the existing simulations only.
- **Sam** is a woman (she/her) and never claims to be a person. Keep the existing AI disclosure lines untouched.
- **Prompt edits are deliberate.** Default-instruction changes go only inside booking or consultation sections. Every golden entry with no `slots` keeps its exact SHA (Task 11).
- **Contracts build first.** After changing `packages/contracts`, run `npm -w packages/contracts run build` before testing services. Services import its `dist`.
- **Commands.** Run a single test file with `npm test -w <workspace> -- <path relative to the workspace>`, for example `npm test -w services/outreach-api -- src/appointments/routing.test.ts`. Typecheck with `npm run typecheck -w <workspace>`.
- **Conventions:**
  - Repo style: small pure functions, immutable updates, comments only where the reason isn't obvious.
  - TDD: RED, then GREEN.
  - Commits use the format `<type>(<scope>): <description>` and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Stage explicit paths only. Never stage `.claude/launch.json`, `apps/cti-ios/App/CTICallerID.entitlements` or `.superpowers/sdd/progress.md`.
  - Never push.
  - No checkout, switch, reset or stash.
  - Never read `.env` files. Never connect to a remote database.

## Review Focus

1. **A booking blob saved before this change** (no `routing`): it still parses, booking stays on, and routing defaults apply. Tested in Task 3 (`settings.test.ts`).
2. **Google is down, or the key is missing, when a call is placed:**
   - no key, or Geocoding fails → no times, note `maps_unavailable`, the call still goes;
   - Routes fails → straight-line estimates, and times are still offered;
   - nothing throws.
   Tested in Task 2 (client errors), Task 4 (fallback) and Task 6 (offer notes).
3. **Event Locations that aren't drivable**, such as empty, `Zoom`, a link, `Phone call`, a phone number, or an address Google can't route: the rep's position is the office, and the Location is never logged. Tested in Task 3 (`usableAddress`) and Task 4 (route not found → office).
4. **Daylight saving ends on Sun Nov 1, 2026.** A region's 9 AM is 9 AM Pacific on both sides. The high-priority default after Fri Oct 30 is Mon Nov 2 09:00 PST, which is `2026-11-02T17:00:00.000Z`. Tested in Task 4 and Task 6.
5. **High-priority times at the edges**: "in an hour", 7:45 AM, 7:00 PM, 7:15 PM, a Saturday, an off-quarter minute, an unconfirmed address. Only valid ones book, and each refusal tells Sam what to offer instead. Tested in Task 10.

## File map

| Area | Files |
|---|---|
| Contracts | `packages/contracts/src/appointments.ts`, `ai-calls.ts` |
| Maps + drive | `services/outreach-api/src/appointments/maps.ts`, `drive.ts`, `config.ts` |
| Calendars, places, settings | `appointments/calendar.ts`, `slots.ts` (Busy), new `places.ts`, `src/settings.ts` |
| Routing engine | new `appointments/routing.ts` |
| Consultations | new `appointments/consultations.ts` |
| Offer | `appointments/offer.ts` (rewritten), `booked.ts`, new `offer-for-record.ts` |
| Wiring | `ai-calls/pace-context.ts`, `pace.ts`, `practice.ts`, `record-tests/preview.ts`, `record-tests/run.ts`, `server.ts`, web `lib/record-test-words.ts` |
| Write-back | `writeback/appointment.ts`, `steps-write.ts`, `row-run.ts` |
| Outcome | cti-api `outcomes.ts`, `store.ts`, `prompt-tools.ts`; outreach-api `ai-calls/outcomes.ts`, `writeback/context.ts`; web `lib/call-words.ts` |
| cti-api tools | `routes-internal.ts`, `service.ts`, `prompt.ts`, `prompt-context.ts`, `stream-session.ts`, `service-tools.ts`, `service-booking.ts`, `prompt-tools.ts`, `store-booking.ts`, `testing.ts` |
| cti-api prompt | `prompt-booking.ts`, `prompt-view.ts`, `prompt-template.ts`, `prompt-default-instructions.ts`, `__fixtures__/prompt-golden.json`, `__snapshots__/prompt-first-call.txt` |
| Settings card | `writeback/readiness.ts`, `routes/ai-call-settings.ts`, web `components/ai-call-settings.tsx`, new `components/booking-regions.tsx` |

---

### Task 1: Contracts

**Files:**
- Modify: `packages/contracts/src/appointments.ts`, `packages/contracts/src/ai-calls.ts`
- Test: `packages/contracts/src/appointments.test.ts`, `packages/contracts/src/ai-calls.test.ts`

**Interfaces:**
- Produces (all exported from `@cti/contracts`):
  ```ts
  export const ROUTING_ZONE = 'America/Los_Angeles';
  export const CONSULTATION_MINUTES = 60;
  export const PRIORITY_SLOT_ID = 'h1';
  export const PRIORITY_RULES = { minLeadMinutes: 120, firstStartHour: 8, endByHour: 20, defaultStartHour: 9, stepMinutes: 15 } as const;
  export const RegionKey: z.ZodString;            // /^[A-Z]{2,6}$/
  export const BookingRegion;                      // { key: RegionKey; counties: string[] (1..12, each 2..40 chars); reps: SfUserId[] (0..6); startTimes: "HH:MM"[] (1..24, strictly ascending) } strict
  export const BookingRouting;                     // { officeAddress: string (10..200); regions: BookingRegion[] (1..6) } strict; keys unique; no county (case-insensitive) in two regions
  // AiCallBookingSettings gains: routing: BookingRouting.optional()
  export const ConsultationFact;                   // { start: IsoInstant; kind: 'in_person' | 'phone'; ownerName: string (1..80, /^[A-Za-z][A-Za-z .'-]*$/) | null } strict
  export const Consultations;                      // { last: ConsultationFact | null; next: ConsultationFact | null } strict
  // CallContext becomes { returning: boolean; consultations?: Consultations } strict
  export const PriorityOffer;                      // { specialistSfUserId; specialistFirstName (same rule as AppointmentSlot's, nullable); timeZone: IanaZone; defaultStart: IsoInstant } strict
  // AppointmentSlot gains: region: RegionKey.optional()
  // BookedAppointment: slotId regex becomes /^(?:[pw][1-9]|h1)$/; gains region?: RegionKey, priority?: z.literal(true),
  //   whatChanged?: z.string().max(300), previousConsultation?: ConsultationFact
  export const RoutingReadiness;                   // { officeAddress: string; mapsConfigured: boolean; regions: { key; counties: string[]; startTimes: string[]; reps: SalesforceUserOption[] }[] }
  // WritebackReadiness gains: routing: RoutingReadiness.nullable().optional()
  // ai-calls.ts: record / practice / practice_browser targets gain priority: PriorityOffer.optional()
  // AiCallOutcome gains 'already_booked'
  ```
  Do not add `.refine` to `BookedAppointment`: it is used as a plain object schema elsewhere. cti-api enforces that `h1` ⇔ `priority: true` (Task 10).

- [ ] **Step 1: Write the failing tests** (add to the existing describe blocks):
  - `'a booking blob saved before routing still parses'`: today's `DEFAULT_AI_CALL_BOOKING` shape plus `enabled: true` and `specialists: ['0058X00000Fsx39QAB']`, with no `routing`, gives `success === true`.
  - `'routing: LA and SD parse'`: use the Global Constraints values.
  - The routing schema rejects: `'Orange'` in both regions; `startTimes ['11:00','09:00']`; `'9:00'`; key `'la'`; `officeAddress 'x'`.
  - `'context with consultations parses'`: `{ returning: false, consultations: { last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' }, next: null } }` parses. With `ownerName: 'Team #2'` it fails.
  - `'a record target with priority parses'`: `priority: { specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-20T16:00:00.000Z' }`. With `defaultStart: 'tomorrow'` it fails.
  - `'a priority booking parses'`: `slotId 'h1', priority: true, whatChanged: 'now they really want to sell'`, plus `previousConsultation`. `slotId 'h2'` fails.
  - `'a slot with region LA parses; la fails'`.
  - `AiCallOutcome.safeParse('already_booked').success === true`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w packages/contracts`
  Expected: FAIL. The new tests fail on unknown keys or values.

- [ ] **Step 3: Implement the schemas in `packages/contracts/src/appointments.ts` and `ai-calls.ts`.** `StartTime` is `/^(?:[01]\d|2[0-3]):[0-5]\d$/`. For the county check, compare `trim().toLowerCase()`.

- [ ] **Step 4: Run the tests and see them pass, then build and typecheck**
  Run: `npm test -w packages/contracts && npm -w packages/contracts run build && npm run typecheck -w packages/contracts`
  Expected: PASS. Build and typecheck are clean.

- [ ] **Step 5: Commit**
  ```bash
  git add packages/contracts/src/appointments.ts packages/contracts/src/ai-calls.ts packages/contracts/src/appointments.test.ts packages/contracts/src/ai-calls.test.ts
  git commit -m "feat(contracts): booking regions, consultation facts, high-priority booking and already_booked"
  ```

---

### Task 2: Google Maps client and drive timer

**Files:**
- Create: `services/outreach-api/src/appointments/maps.ts`, `maps.test.ts`, `drive.ts`, `drive.test.ts`
- Modify: `services/outreach-api/src/config.ts`, `config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // maps.ts
  export interface GeoPoint { lat: number; lng: number }
  export type Place = { address: string } | { point: GeoPoint };
  export interface Geocoded { point: GeoPoint; county: string | null; state: string | null }
  export interface RouteMatrix { minutes: (number | null)[][]; requestedElements: number }
  /** `code` only: 'timeout' | 'network' | 'http_<status>' | 'bad_response' | a Google status such as 'OVER_QUERY_LIMIT'. Never an address or URL. */
  export class MapsUnavailableError extends Error { constructor(readonly code: string) }
  export interface MapsClient {
    geocode(address: string): Promise<Geocoded | null>;                 // null = Google found nothing
    routeMinutes(origins: readonly Place[], destinations: readonly Place[], departure: Date): Promise<RouteMatrix>;
  }
  export const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
  export const ROUTE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
  export const MAPS_TIMEOUT_MS = 4_000;
  export function googleMaps(apiKey: string, opts?: { fetch?: typeof fetch; now?: () => Date }): MapsClient;
  // drive.ts
  export const FALLBACK_ROAD_FACTOR = 1.3;
  export const FALLBACK_MPH = 45;
  export function straightLineMinutes(a: GeoPoint, b: GeoPoint): number;   // ceil(haversine miles (R = 3958.8) × 1.3 / 45 × 60)
  export interface DriveTimer {
    /** Minutes per origin × destination (null = no route). Falls back to straight lines when Google is unavailable. */
    matrix(origins: readonly Place[], destinations: readonly Place[], departure: Date): Promise<(number | null)[][]>;
    /** Route elements this timer has asked Google for (cache hits and fallback estimates are free). */
    spent(): number;
  }
  export function driveTimer(maps: MapsClient, office: Place, log: { warn(o: Record<string, unknown>, m: string): void }): DriveTimer;
  ```
  - Config gains `GOOGLE_MAPS_API_KEY: z.string().min(1).optional()`. It is wired in Task 7.

- [ ] **Step 1: Write the failing tests** (`maps.test.ts` with an injected fake `fetch`; `drive.test.ts` with a fake `MapsClient`):
  - Geocode request: a GET to `GEOCODE_URL` with `address=<encoded>`, `components=country:US` and `key=<key>`.
  - Geocode response: `status OK` and county component `'San Diego County'` give `{ county: 'San Diego', state: 'CA', point: { lat, lng } }`.
  - Geocode cache: a second call for the same address, differing only in case or whitespace, makes **no** second fetch.
  - Geocode errors:
    - `ZERO_RESULTS` → `null`;
    - `OVER_QUERY_LIMIT` → throws `MapsUnavailableError` with `code 'OVER_QUERY_LIMIT'`;
    - HTTP 500 → `code 'http_500'`;
    - an aborted fetch → `code 'timeout'`;
    - a body that isn't JSON → `code 'bad_response'`.
  - Routes request: a POST to `ROUTE_MATRIX_URL` with headers `X-Goog-Api-Key: <key>` and `X-Goog-FieldMask: originIndex,destinationIndex,duration,condition,status`. The body has `travelMode: 'DRIVE'`, `routingPreference: 'TRAFFIC_AWARE'`, address waypoints as `{ waypoint: { address } }` and points as `{ waypoint: { location: { latLng: { latitude, longitude } } } }`.
  - Routes departure: `departureTime` is the departure's ISO string. A departure in the past is sent as `now + 60 s`.
  - Routes response: elements come back out of order and are placed by `originIndex` and `destinationIndex`. `duration '1530s'` → `26`. `condition 'ROUTE_NOT_FOUND'` → `null`. `status: { code: 5 }` → `null`.
  - Routes counting: `requestedElements` is 4 for a 2×2 matrix. Repeating the same call (same places, departure in the same clock hour) gives `requestedElements: 0` and makes no fetch.
  - No error message contains the address or the key.
  - `straightLineMinutes({lat:0,lng:0},{lat:0,lng:1}) === 120`; the same point → `0`.
  - Drive timer fallback: Routes throws `MapsUnavailableError`, so the timer geocodes each address through `maps.geocode` and returns straight-line minutes. An address that geocodes to `null` uses the office's point. It warns once per timer with `{ code }` only, and `spent()` stays 0.
  - Config: `GOOGLE_MAPS_API_KEY` is optional; when present it is read as given.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/appointments/maps.test.ts src/appointments/drive.test.ts src/config.test.ts`
  Expected: FAIL. The modules don't exist.

- [ ] **Step 3: Implement `maps.ts`, `drive.ts` and the config key.**
  - Use `AbortSignal.timeout(MAPS_TIMEOUT_MS)`.
  - Caches live inside `googleMaps` and last for the process:
    - geocode: 24 h, at most 2,000 entries, the oldest evicted first;
    - route elements: keyed `origin>destination@<departure hour ISO>`, 24 h, at most 10,000 entries.
    When a matrix has some cached pairs, request only the origins and destinations that still have a missing pair.
  - `maps.ts` never logs.

- [ ] **Step 4: Run the tests and see them pass**
  Run: the command from Step 2
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/appointments/maps.ts services/outreach-api/src/appointments/maps.test.ts services/outreach-api/src/appointments/drive.ts services/outreach-api/src/appointments/drive.test.ts services/outreach-api/src/config.ts services/outreach-api/src/config.test.ts
  git commit -m "feat(outreach-api): Google geocoding and drive-time matrix with a straight-line fallback"
  ```

---

### Task 3: Rep calendars, places and the routing settings

**Files:**
- Modify: `services/outreach-api/src/appointments/slots.ts` (the `Busy` type), `calendar.ts`, `calendar.test.ts`, `services/outreach-api/src/settings.ts`, `settings.test.ts`
- Create: `services/outreach-api/src/appointments/places.ts`, `places.test.ts`

**Interfaces:**
- Consumes: `Geocoded` (Task 2); `BookingRouting` and `BookingRegion` (Task 1).
- Produces:
  ```ts
  // slots.ts — Busy gains two optional fields (existing producers and tests keep working)
  location?: string | null;     // the Event's Location as Salesforce has it (never logged)
  consultation?: boolean;       // its Subject contains "consultation" (case-insensitive); the Subject itself is not kept
  // calendar.ts
  export function repBusySoql(ownerIds: readonly string[], from: Date, to: Date, timeZone: string): string;  // today's busySoql for many owners, also selecting OwnerId, Location, Subject
  export async function readRepCalendars(client: SalesforceClient, ownerIds: readonly string[], from: Date, to: Date, timeZone: string, onCapped?: (rows: number) => void): Promise<Map<string, Busy[]>>;  // keyed by the 15-char id core; every valid asked id is present
  // readBusy keeps its signature and now fills location and consultation (it delegates to repBusySoql([ownerId], …)).
  // places.ts
  export function usableAddress(location: string | null | undefined): string | null;
  export function countyKey(name: string): string;                       // 'San Diego County' → 'san diego'
  export function regionFor(geo: Geocoded, routing: BookingRouting): BookingRegion | null;   // CA only; county matched by countyKey
  // settings.ts
  export const DEFAULT_BOOKING_ROUTING: Readonly<BookingRouting>;       // the Global Constraints values
  export function bookingRouting(b: AiCallBookingSettings): BookingRouting;   // b.routing ?? DEFAULT_BOOKING_ROUTING
  // bookingSettings(...) returns routing filled in; bookingActive(b) becomes: b.enabled && some region has at least one rep
  ```

- [ ] **Step 1: Write the failing tests**
  - `usableAddress` turns `'  18872 MacArthur Blvd #220,   Irvine '` into `'18872 MacArthur Blvd #220, Irvine'`. `'1234 Oak St, Riverside, CA 92501'` comes back unchanged.
  - Each of these returns `null`: `null`, `''`, `'Zoom'`, `'Phone call'`, `'Office'`, `'TBD'`, `'555-123-4567'`, `'https://zoom.us/j/123'`, `'www.example.com/123 Main'`.
  - The rule: after collapsing spaces, the text is 8–200 characters, matches `/\b\d{1,6}[A-Za-z]?\s+[A-Za-z]{2,}/`, and does not match `/(https?:|www\.|zoom|teams\.|meet\.google|webex)/i`.
  - `regionFor`, with the default routing:
    - `('Los Angeles','CA')`, `('Orange','CA')` and `('SAN BERNARDINO','CA')` → LA;
    - `('San Diego','CA')` → SD;
    - `('Imperial','CA')` → null; `('Orange','NV')` → null; `(null,'CA')` → null.
  - `repBusySoql(['0055f000005qXn8AAE','0058X00000FA8tLQAT'], …)` contains `OwnerId IN ('0055f000005qXn8AAE', '0058X00000FA8tLQAT')` and selects `OwnerId, Location, Subject`. A bad id throws, as `busySoql` does.
  - `readRepCalendars` sorts rows by `OwnerId` into the map. It sets `consultation: true` for `'Property Consultation 127 …'` and `false` for `'Team meeting'`, and carries `location` through. An asked rep with no rows maps to `[]`. It hits the cap at `BUSY_ROW_LIMIT`, as `readBusy` does.
  - Settings, the saved-blob case: `bookingSettings` on a saved blob without `routing` keeps `enabled: true` and returns `routing` deep-equal to `DEFAULT_BOOKING_ROUTING`.
  - `DEFAULT_BOOKING_ROUTING` parses with `BookingRouting` and equals the Global Constraints values exactly. That covers counties, reps in that order, start times and the office.
  - `bookingActive`:
    - `enabled: true` with default routing and `specialists: []` → `true`;
    - `enabled: false` → `false`;
    - routing whose regions all have `reps: []` → `false`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/appointments/places.test.ts src/appointments/calendar.test.ts src/settings.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement.** Find every caller of `bookingActive` (`grep -rn bookingActive services/outreach-api/src`) and check each still means "booking may offer times".

- [ ] **Step 4: Run the tests and see them pass, plus the existing appointment tests**
  Run: `npm test -w services/outreach-api -- src/appointments src/settings.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/appointments/slots.ts services/outreach-api/src/appointments/calendar.ts services/outreach-api/src/appointments/calendar.test.ts services/outreach-api/src/appointments/places.ts services/outreach-api/src/appointments/places.test.ts services/outreach-api/src/settings.ts services/outreach-api/src/settings.test.ts
  git commit -m "feat(outreach-api): booking regions by county, rep calendars with locations, routing defaults"
  ```

---

### Task 4: The routing engine

**Files:**
- Create: `services/outreach-api/src/appointments/routing.ts`, `routing.test.ts`

**Interfaces:**
- Consumes:
  - `Busy` and `usableAddress` (Task 3);
  - `Place` and `DriveTimer` (Task 2);
  - `OwnerUser` (`calendar.ts`);
  - `conflicts` (`slots.ts`), `zonedInstant`, `zonedParts` and `addLocalDays` (`zoned.ts`);
  - `CONSULTATION_MINUTES`, `ROUTING_ZONE`, `BookingRegion` and `AppointmentSlot` (Task 1).
- Produces:
  ```ts
  export const MAX_ROUTE_ELEMENTS_PER_OFFER = 60;
  export interface RepCalendar { rep: OwnerUser; busy: readonly Busy[] }
  export interface RoutingInput {
    region: BookingRegion;
    /** The region's ACTIVE reps in region order, each with its calendar (AI bookings not on it yet already added). */
    reps: readonly RepCalendar[];
    booking: AiCallBookingSettings;   // days, phone/walkthrough: enabled, minLeadMinutes, horizonBusinessDays, maxOffered
    now: Date;
  }
  export async function inPersonSlots(i: RoutingInput & { property: Place; office: Place; drive: DriveTimer }): Promise<AppointmentSlot[]>;  // ids w1…
  export function phoneSlots(i: RoutingInput): AppointmentSlot[];                                                                            // ids p1…
  /** The write-back's re-check of one booked rep (Task 8): both drives fit, each allowed `slackMinutes`. */
  export async function repCanReach(i: { busy: readonly Busy[]; start: Date; property: Place; office: Place; drive: DriveTimer; slackMinutes: number }): Promise<boolean>;
  ```
- The rules:
  - **Candidates:**
    - Take the first `horizonBusinessDays` local days in `ROUTING_ZONE`, counting from today, whose ISO weekday is in `booking.days`.
    - On each day, every region start time is a candidate. Keep a start only if it is ≥ `now + minLeadMinutes`.
    - The window is [start, start + 60 min).
  - **Free:** a rep is free when `conflicts(window, busy, ROUTING_ZONE, 0)` is false.
  - **Earlier and later:**
    - Earlier = the rep's timed busy item that local day with the latest end ≤ start.
    - Later = the item that day with the earliest start ≥ end.
    - An item's place is `{ address: usableAddress(location) }`, or the office when that is null.
  - **In person, a rep fits when both drives fit:**
    - Drive-in: either there is no earlier item, or earlier.end + drive-in ≤ start. Drive-in is from the earlier item's place (or the office) to the property, departing at start − 60 min.
    - Drive-out: either there is no later item, or end + drive-out ≤ later.start. Drive-out is from the property to the later item's place, departing at end.
    - A `null` route for an address → ask again with the office in its place. A `null` route from or to the office → the rep doesn't fit.
  - **Look up drive-in only when needed:** when the rep has an earlier item, or when another free rep starts from a different place, because then it is needed to compare them.
  - **Winner:**
    1. The smallest drive-in among the reps that fit. Reps with no lookup count as equal.
    2. Tie → fewer `consultation` busy items whose start falls in the candidate's ISO week (Mon–Sun, `ROUTING_ZONE`).
    3. Tie → region order.
  - **Phone:** free reps only, with no drive. Winner: fewer consultation items that local day; tie → region order.
  - **Per day:** keep the first fitting morning time (hour < 12) and the first fitting afternoon time. Once a morning is found, skip the rest of that day's mornings.
  - **Stop** when the kind's `maxOffered` is reached, or once `drive.spent() ≥ MAX_ROUTE_ELEMENTS_PER_OFFER` (checked before each candidate).
  - **Slots:**
    - Ordered by time, with ids `w1…` or `p1…`.
    - `specialistSfUserId`, `specialistFirstName` and `timeZone` come from the winner's `OwnerUser`.
    - `region` is the region key. There is no `blockStart` or `blockEnd`.
  - A disabled kind → `[]`.

- [ ] **Step 1: Write the failing tests.**
  - Setup:
    - Reps C (`0055f000005qXn8AAE`, Chance) and B (`0058X00000FA8tLQAT`, Blake), default LA region.
    - `now = 2026-10-19T16:00:00Z` (Mon 09:00 PDT).
    - `booking.walkthrough = { enabled: true, minLeadMinutes: 1200, horizonBusinessDays: 2, maxOffered: 6, … }`, `days [1..5]`.
    - `fakeDrive(table)` records every `matrix` call and lets each test set `spent()`.
    - Tue 2026-10-20 09:00 PDT is `16:00Z`, 13:00 PDT is `20:00Z`.
  - `'both reps free from the office: no route lookup; fewer consultations that week wins'`: C has 3 consultation items on Mon Oct 19 and B has 1. Expect `w1` at `2026-10-20T16:00:00.000Z` with B and `w2` at `2026-10-20T20:00:00.000Z` with B, `region 'LA'`, and `fakeDrive` never called.
  - `'the shorter drive in wins'`: C has an item Tue 07:00–08:30 PDT at `'100 Main St, Anaheim, CA'` with a 20-minute drive to the property. B comes from the office at 45 minutes. `w1` goes to C.
  - `'a drive in that does not fit'`: C's earlier item ends 08:45 and the drive is 30 minutes. `w1` goes to B.
  - `'the drive to the next appointment must fit'`: C has a later item at 10:15 PDT with a 30-minute drive out. C is out at 09:00.
  - `'an unusable Location starts from the office'`: C's earlier item has Location `'Zoom'`. The matrix origin passed is the office `Place`.
  - `'a route Google cannot find uses the office drive'`: `null` from the address and 25 from the office. C's earlier item ends 08:30, and 08:30 + 25 ≤ 09:00, so C fits.
  - `'overlap and all-day items make a rep not free'`: C is busy 09:30–10:30 and B has an all-day item on Tue. Neither is offered at 09:00.
  - `'stops at maxOffered and at the route budget'`: with `maxOffered: 1`, only `w1`. With `spent()` returning 60 from the start, no in-person slots and no further `matrix` calls.
  - `'SD region: first morning 09:00, first afternoon 12:00'`: `phoneSlots` on a free Tuesday with `minLeadMinutes: 0` and `horizonBusinessDays: 2`. Monday from 09:00 PDT on gives 09:00 and 12:00, Tuesday 09:00 and 12:00; with `maxOffered: 6` that is p1..p4.
  - `'daylight saving ends'`: `now = 2026-10-30T16:00:00Z` (Fri) and `horizonBusinessDays: 2`. `w1.start === '2026-11-02T17:00:00.000Z'` (Mon 09:00 PST).
  - `'phone: no drive lookups; fewer consultations that day wins'`: C has 2 consultation items on Tue and B has 0. `p` at Tue 09:00 goes to B, and `fakeDrive` is never called.
  - `'repCanReach allows the slack'`: the earlier item ends 08:45 and the start is 09:00. A 25-minute drive-in with slack 15 → `true`; 35 → `false`. A later item at 10:20 with a 25-minute drive-out and slack 15 → `true`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/appointments/routing.test.ts`
  Expected: FAIL. The module doesn't exist.

- [ ] **Step 3: Implement `routing.ts`.**
  - Reuse `conflicts` and the zoned helpers. Don't copy them.
  - Write a pure helper that finds a rep's earlier and later items around a window. `inPersonSlots`, `phoneSlots` and `repCanReach` all share it.
  - When both reps need a drive-in, look them up in one `matrix` call (all their origins → [property]).

- [ ] **Step 4: Run the tests and see them pass**
  Run: the command from Step 2
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/appointments/routing.ts services/outreach-api/src/appointments/routing.test.ts
  git commit -m "feat(outreach-api): choose the regional rep for each time by drive time, then weekly load"
  ```

---

### Task 5: Past and upcoming consultations

**Files:**
- Create: `services/outreach-api/src/appointments/consultations.ts`, `consultations.test.ts`

**Interfaces:**
- Consumes: `Consultations` (Task 1).
- Produces:
  ```ts
  export interface ConsultationLinks { whoIds: string[]; whatIds: string[] }
  /** The record itself plus the research records around it: Leads (00Q…) and Contacts (003…) as Who, Opportunities (006…) as What. Bad ids dropped; each id once by its 15-char core. */
  export function consultationLinks(record: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string }, around?: ReadonlyArray<{ sfObject: string; id: string }>): ConsultationLinks;
  export function consultationsSoql(links: ConsultationLinks): string | null;   // null when both lists are empty
  /** The latest consultation that started before `now`, and the earliest at or after it. Throws on a Salesforce error (the caller degrades). */
  export async function readConsultations(client: SalesforceClient, links: ConsultationLinks, now: Date): Promise<Consultations>;
  ```
- The query reads `StartDateTime, Subject, Owner.Name`. It selects Events where `Subject LIKE '%Consultation%' AND IsAllDayEvent = false AND (WhoId IN (…) OR WhatId IN (…))`, ordered by `StartDateTime DESC`, `LIMIT 50`. Leave out a list that is empty.
- Field rules:
  - `kind` is `'phone'` when the Subject contains "phone" (case-insensitive), else `'in_person'`.
  - `ownerName` is `Owner.Name` when it passes the contract rule, else `null`.
  - The Subject is never returned or logged.
- From the 2026-10-19 read of `_t2`: every consultation Event in the last year sat on an Opportunity (`WhatId 006…`) and none had a `WhoId`. The query still covers both, as the spec says.

- [ ] **Step 1: Write the failing tests**
  - `consultationLinks`:
    - Opportunity `006…A` with `around` = [Contact `003…`, Account `001…`, Opportunity `006…B`, the self block `006…A` again] → `whatIds [A, B]`, `whoIds [contact]`.
    - Lead `00Q…` with no `around` → `whoIds [lead]`.
    - A malformed id is dropped.
  - `consultationsSoql` gives the exact text for one Opportunity id. It returns `null` for empty links.
  - `readConsultations` with `now = 2026-10-19T16:00:00Z` and rows:
    - `2026-10-22T18:00Z 'Phone Consultation' 'Seth Boisvert'`
    - `2026-03-12T17:00Z 'Property Consultation 127 …' 'Blake Kossuth'`
    - `2025-11-01T17:00Z 'Property Consultation' 'Nolan Weber'`

    It returns `{ last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' }, next: { start: '2026-10-22T18:00:00.000Z', kind: 'phone', ownerName: 'Seth Boisvert' } }`.
  - `Owner.Name 'Calendar: Team #2'` → `ownerName: null`.
  - Empty links → no query; returns `{ last: null, next: null }`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/appointments/consultations.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement `consultations.ts`.** Reuse `soqlIdList` and `SF_ID`.

- [ ] **Step 4: Run the tests and see them pass**
  Run: the command from Step 2
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/appointments/consultations.ts services/outreach-api/src/appointments/consultations.test.ts
  git commit -m "feat(outreach-api): read a seller's past and upcoming consultations before a call"
  ```

---

### Task 6: The routed offer

**Files:**
- Modify (rewrite): `services/outreach-api/src/appointments/offer.ts`, `offer.test.ts`, `offer-invalid.test.ts`
- Modify: `services/outreach-api/src/appointments/booked.ts`, `booked.test.ts`
- Create: `services/outreach-api/src/appointments/offer-for-record.ts`, `offer-for-record.test.ts`

**Interfaces:**
- Consumes:
  - `readRepCalendars`, `regionFor`, `usableAddress` and `bookingRouting` (Task 3);
  - `inPersonSlots`, `phoneSlots` and `RepCalendar` (Task 4);
  - `driveTimer` and `MapsClient` (Task 2);
  - `readConsultations` and `consultationLinks` (Task 5);
  - `readUsers`, `appointmentOwner` (the priority rep: first active on `specialists`) and `readCurrent(...).address` (`writeback/fields.ts`).
- Produces:
  ```ts
  // offer.ts
  export type OfferNote = 'booking_off' | 'no_reps' | 'salesforce_error' | 'no_address' | 'maps_unavailable' | 'not_found'
    | 'outside_regions' | 'already_booked' | 'no_free_time' | 'invalid_slots';
  export interface Offer { slots: AppointmentSlot[]; priority: PriorityOffer | null; region: string | null; ownerSfUserId: string | null; note: OfferNote | null }
  export type OfferCalendars =
    | { kind: 'read'; routing: BookingRouting; reps: ReadonlyMap<string, RepCalendar>; priority: OwnerUser | null; from: Date; until: Date }
    | { kind: 'none'; note: 'booking_off' | 'no_reps' | 'salesforce_error' };
  export const OFFER_CALENDAR_DAYS = 15;
  /** Reads Salesforce only; never throws. from = 00:00 Monday of this week (ROUTING_ZONE), until = now + 15 days. Only active reps are kept. */
  export async function readOfferCalendars(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date; log?: OfferLog }): Promise<OfferCalendars>;
  export interface OfferDeps { db: Db; maps: MapsClient | null; log: OfferLog & { info(o: Record<string, unknown>, m: string): void } }
  /** Never throws. */
  export async function routedOffer(deps: OfferDeps, cal: OfferCalendars, i: { orgId: string; booking: AiCallBookingSettings; now: Date; address: string | null; consultations: Consultations | null }): Promise<Offer>;
  /** The next local day after today (ROUTING_ZONE) whose ISO weekday is in `days`, at PRIORITY_RULES.defaultStartHour:00. */
  export function priorityDefaultStart(days: readonly number[], now: Date): Date;
  // booked.ts — replaces the one-owner form; offerWithAiBookings is removed (routedOffer does this)
  export async function bookedNotOnCalendar(db: Db, a: { orgId: string; repSfUserIds: readonly string[]; now: Date; until: Date }): Promise<Map<string, Busy[]>>;  // by 15-char core; items have consultation: true, location: null
  // offer-for-record.ts
  export interface RecordOfferInput { orgId: string; booking: AiCallBookingSettings; now: Date; record: { sfObject: 'Lead' | 'Opportunity'; sfRecordId: string }; around: ReadonlyArray<{ sfObject: string; id: string }> }
  /** The property address (readCurrent), the consultations (read even when booking is off, since Sam still mentions them; a read error → null, logged by errName) and routedOffer. Never throws. */
  export async function offerForRecord(deps: OfferDeps & { client: SalesforceClient; calendars: () => Promise<OfferCalendars>; oppDescribe?: () => Promise<SObjectDescribe> }, i: RecordOfferInput): Promise<{ offer: Offer; consultations: Consultations | null }>;
  ```
- `routedOffer`, in order:
  1. `cal.kind === 'none'` → its note.
  2. `consultations?.next` → `already_booked`. No slots, no priority.
  3. No address → `no_address`.
  4. `maps === null`, or geocode throws → `maps_unavailable`. Geocode returns `null` → `not_found`.
  5. `regionFor` is null → `outside_regions`, with no priority either (owner decision 2).
  6. The region's reps present in `cal.reps`, with that rep's `bookedNotOnCalendar` items added to its busy. None → `no_reps`.
  7. In-person slots only when `usableAddress(address)` is not null:
     - `property = { point: geo.point }`, `office = { address: routing.officeAddress }`;
     - one `driveTimer` per offer.
     Phone slots always.
  8. `priority` when `cal.priority` exists and the address is usable: `{ specialistSfUserId, specialistFirstName, timeZone, defaultStart: priorityDefaultStart(booking.days, now).toISOString() }`.
  9. No slots and no priority → `no_free_time`. Slots that fail `AppointmentSlots.safeParse` → `invalid_slots`.
  10. `ownerSfUserId` = the first slot's rep, else the priority rep, else null.
  11. Log one info line: `{ orgId, region, slots: n, priority: bool, routeElements: drive.spent() }`.

- [ ] **Step 1: Write the failing tests.** Use fake Salesforce clients (calendar rows, user rows), a fake `MapsClient` and a fake `bookedNotOnCalendar` db, following the existing `offer.test.ts` patterns.
  - `'San Diego property → SD reps'`: every in-person slot has `region 'SD'` and its rep in {Seth, Thomas}.
  - `'Orange County → LA reps'`.
  - `'Imperial County → outside_regions, no slots, no priority'`.
  - `'an upcoming consultation → already_booked, no slots, no priority'`.
  - `'city only, no street → phone slots, no in-person, no priority'`.
  - `'maps null → maps_unavailable'`; `'geocode throws → maps_unavailable'`.
  - `'Routes down → in-person times from straight lines'`: in-person slots are still offered.
  - `'priority with Grant'`: `specialists ['0058X00000Fsx39QAB']` and Grant active. `priority.defaultStart` is `'2026-10-20T16:00:00.000Z'` when `now = 2026-10-19T16:00:00Z`.
  - `'an AI booking not on the calendar blocks that rep'`: Blake has an AI booking Tue 09:00–10:00, so Tue 09:00 goes to Chance.
  - `'readOfferCalendars never throws'`: a rejecting `client.query` gives `{ kind: 'none', note: 'salesforce_error' }`. An inactive rep is dropped. A region whose reps are all inactive gives no slots and the note `no_reps`.
  - `priorityDefaultStart([1,2,3,4,5], …)`:
    - Mon 2026-10-19T23:00Z → `2026-10-20T16:00:00.000Z`;
    - Fri 2026-10-23T16:00Z → `2026-10-26T16:00:00.000Z`;
    - Fri 2026-10-30T16:00Z → `2026-11-02T17:00:00.000Z`.
  - `bookedNotOnCalendar` sorts AI bookings for two reps into the map by rep core. Test and practice calls are ignored, as they are today. The `bookingStands` rule is unchanged.
  - `offerForRecord`:
    - consultations are read with links from the record plus `around`;
    - a consultations read error gives `consultations: null` and the offer still comes back;
    - a Lead target makes no Opportunity describe call.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/appointments`
  Expected: FAIL. The new names don't exist.

- [ ] **Step 3: Implement.** Keep `owner.ts`; `appointmentOwner` now picks the priority rep. Delete the single-owner `offerFrom`, `offerSlots` and `readOfferCalendar` once nothing imports them. Their callers move in Task 7, so keep the old exports only until then if typecheck needs them.

- [ ] **Step 4: Run the tests and see them pass**
  Run: the command from Step 2
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/appointments/offer.ts services/outreach-api/src/appointments/offer.test.ts services/outreach-api/src/appointments/offer-invalid.test.ts services/outreach-api/src/appointments/booked.ts services/outreach-api/src/appointments/booked.test.ts services/outreach-api/src/appointments/offer-for-record.ts services/outreach-api/src/appointments/offer-for-record.test.ts
  git commit -m "feat(outreach-api): the routed offer: region, per-slot reps, high priority and consultations"
  ```

---

### Task 7: Wire the routed offer into calls, practice calls and record tests

**Files:**
- Modify: `services/outreach-api/src/ai-calls/pace-context.ts`, `pace.ts`, `practice.ts`, `services/outreach-api/src/record-tests/preview.ts`, `run.ts`, `services/outreach-api/src/server.ts`, `apps/outreach-web/src/lib/record-test-words.ts`
- Test: `services/outreach-api/src/ai-calls/pace-slots.test.ts`, `practice.test.ts`, `record-tests/*.test.ts` (the existing ones that build offers), `apps/outreach-web/src/lib/record-test-words.test.ts` (create if absent)

**Interfaces:**
- Consumes: `offerForRecord`, `readOfferCalendars`, `OfferCalendars` and `Offer` (Task 6); `googleMaps` (Task 2).
- Produces:
  - `PaceDeps`, `PracticeOfferDeps` and the record-test deps each gain `maps: MapsClient | null`.
  - `OrgTick.calendar()` becomes `calendars(): Promise<OfferCalendars>`, read at most once per tick. `OrgTick` gains `oppDescribe(): Promise<SObjectDescribe>`, read at most once per tick.
  - `PlanForCall` gains `around: Array<{ sfObject: string; id: string }>`, taken from the research snapshot's `records`. It is `[]` when the snapshot doesn't parse.
  - `tickOffer(deps, tick, c, plan)` returns `{ offer, consultations }`.
  - `practiceOffer(deps, orgId, settings, record, around, label?)` returns `{ offer, consultations }`. `practiceSlots` is removed; callers use `practiceOffer`.
  - Every trigger target carries:
    - `context: { returning, ...(consultations ? { consultations } : {}) }`;
    - `slots` as today, sent only when there are any;
    - `...(offer.priority ? { priority: offer.priority } : {})`.
    The CF-13 rule for a kept key also applies to `priority`: send it only when the trigger goes as fresh.
  - `server.ts` creates the client once: `const maps = cfg.GOOGLE_MAPS_API_KEY ? googleMaps(cfg.GOOGLE_MAPS_API_KEY) : null;`. It passes `maps` to `placeDueAiCalls`, the practice and record-test routes, `runWritebacks` (Task 8) and the AI call settings routes (Task 12).
  - Web `OFFER_NOTE_WORDS` gains:
    - `no_reps`: 'No active rep in any region, so no times would be offered.'
    - `no_address`: 'The record has no property address, so no times would be offered.'
    - `maps_unavailable`: "Couldn't look up the property on the map (Google Maps key missing or Google unavailable), so no times would be offered."
    - `not_found`: "Google couldn't find the property address, so no times would be offered."
    - `outside_regions`: 'The property is outside the LA and San Diego regions, so no times would be offered.'
    - `already_booked`: 'The seller already has a consultation booked, so no new times would be offered.'

- [ ] **Step 1: Write the failing tests**
  - Pace: a due touch whose fakes give slots, a priority offer and a past consultation. The cti trigger body has `target.slots`, `target.priority` and `target.context.consultations.last`.
  - Pace: one tick with two touches reads the rep calendars **once**, counting `client.query` calls on the Event busy SOQL.
  - Pace: a kept key that was stored sends no slots and no priority.
  - Practice: the trigger body carries `context.consultations` and `priority`.
  - Web: `offerNoteWords('outside_regions')` returns the words above.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/ai-calls src/record-tests && npm test -w apps/outreach-web -- src/lib/record-test-words.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement the wiring.** Keep the existing never-log rules: notes and ids only.

- [ ] **Step 4: Run the whole outreach-api suite, the web test and typecheck**
  Run: `npm test -w services/outreach-api && npm test -w apps/outreach-web -- src/lib/record-test-words.test.ts && npm run typecheck -w services/outreach-api`
  Expected: PASS. Typecheck is clean.

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/ai-calls/pace-context.ts services/outreach-api/src/ai-calls/pace.ts services/outreach-api/src/ai-calls/practice.ts services/outreach-api/src/ai-calls/pace-slots.test.ts services/outreach-api/src/ai-calls/practice.test.ts services/outreach-api/src/record-tests services/outreach-api/src/server.ts apps/outreach-web/src/lib/record-test-words.ts apps/outreach-web/src/lib/record-test-words.test.ts
  git commit -m "feat(outreach-api): calls carry routed times, the high-priority offer and consultation facts"
  ```
  (`git add services/outreach-api/src/record-tests` stages only the files you changed there. Check with `git status` first.)

---

### Task 8: Write-back: subjects, the earlier consultation, and the drive re-check

**Files:**
- Modify: `services/outreach-api/src/writeback/appointment.ts`, `appointment.test.ts`, `steps-write.ts`, its tests (`run.test.ts` or the file that covers `taskStep`), `row-run.ts` (`WritebackDeps.maps`)

**Interfaces:**
- Consumes:
  - `repCanReach` (Task 4);
  - `driveTimer` and `MapsClient` (Task 2);
  - `readBusy` with locations (Task 3);
  - `bookingRouting` (Task 3);
  - the `BookedAppointment` fields from Task 1.
- Produces:
  - `WritebackDeps.maps: MapsClient | null`.
  - `bookOpportunity` input gains `maps: MapsClient | null; officeAddress: string; log`.
  - `AppointmentResult` conflict becomes `{ kind: 'conflict'; reason?: 'drive' }`.
  - `export const PRIORITY_SUBJECT = 'High Priority Property Consultation';`
  - `export function previousConsultationLine(b: BookedAppointment): string | null`.
- The rules:
  - **Subject:** `priority` → `PRIORITY_SUBJECT`. Otherwise as today (`Property Consultation` or `Phone Consultation`).
  - **Description:** starts with `previousConsultationLine` when `previousConsultation` is set:
    - format: `Previous consultation: <Mon D>[, <YYYY> when the year differs from the booking's] with <ownerName>. What changed: <whatChanged>.`;
    - leave out ` with <ownerName>` when the name is null;
    - an empty `whatChanged` → `What changed: the seller didn't say.`;
    - the date is in PT.
    After it come today's sentences, unchanged.
  - **Calendar check:**
    - `priority` → no calendar read or check at all (owner: regardless of his calendar);
    - `region` set → overlap check with **0** buffer. For a walkthrough with a location and `maps` present, also `repCanReach` with slack **15**, using that local day's busy (read with `readBusy` from 00:00 to 24:00 PT of the booking's day). A `false` → `{ kind: 'conflict', reason: 'drive' }`;
    - no `region` (booked before this change) → exactly today's check with the walkthrough buffer.
  - **Task words:** `reason 'drive'` → why = `the rep's calendar no longer leaves time to drive there`. Kind words in Task and Chatter text become `phone consultation`, `property consultation` and, for priority, `high-priority property consultation`.

- [ ] **Step 1: Write the failing tests**
  - `opportunityEventFields` for a priority booking → `Subject 'High Priority Property Consultation'`, `OwnerId` = Grant, `Location` set.
  - The Description, as the exact string for previous `2026-03-12T17:00:00.000Z` with Blake Kossuth and whatChanged `seller says it didn't work out last time, now they really want to sell`, starts with `Previous consultation: Mar 12 with Blake Kossuth. What changed: seller says it didn't work out last time, now they really want to sell. Booked by the AI assistant on a call (AI call `.
  - Previous from 2025 → `Mar 12, 2025`. An empty whatChanged → `What changed: the seller didn't say.`.
  - A priority booking over a busy calendar → `created`, with no busy SOQL issued.
  - A routed walkthrough with an earlier Event ending 08:45 at an address:
    - fake drive 40 → `{ kind: 'conflict', reason: 'drive' }` and no create;
    - fake drive 25 → `created`.
  - `maps: null` → overlap check only → `created`.
  - A booking with no `region` → existing buffer tests still pass unchanged.
  - The `taskStep` words for `reason: 'drive'`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/outreach-api -- src/writeback`
  Expected: FAIL

- [ ] **Step 3: Implement.** `appointmentStep` passes `maps: run.deps.maps`, `officeAddress: bookingRouting(booking).officeAddress` and `log: run.deps.log`. The runner deps get `maps` from `server.ts` (Task 7 already passes it).

- [ ] **Step 4: Run the tests and see them pass, then typecheck**
  Run: `npm test -w services/outreach-api -- src/writeback && npm run typecheck -w services/outreach-api`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/writeback/appointment.ts services/outreach-api/src/writeback/appointment.test.ts services/outreach-api/src/writeback/steps-write.ts services/outreach-api/src/writeback/row-run.ts
  git commit -m "feat(outreach-api): write-back names high-priority consultations, notes the earlier one, re-checks the drive"
  ```
  Add the test file that covers `taskStep` to `git add` as well.

---

### Task 9: The "already booked" call outcome

**Files:**
- Modify:
  - `services/cti-api/src/ai-voice/outcomes.ts`, `store.ts` (the `AiCallOutcome` union), `prompt-tools.ts` (`END_CALL_OUTCOMES`);
  - `services/outreach-api/src/ai-calls/outcomes.ts`, `writeback/context.ts`;
  - `apps/outreach-web/src/lib/call-words.ts`.
- Test: `services/cti-api/src/ai-voice/outcomes.test.ts`, `services/outreach-api/src/ai-calls/outcomes.test.ts`, the web `call-words` test.

**Interfaces:**
- Produces:
  - `OUTCOME_WORDS.already_booked = 'Already booked'`. `ctiDisposition('already_booked') === 'Connected'` through the default.
  - `END_CALL_OUTCOMES` includes `'already_booked'`. It is offered to the model only on a call with an upcoming consultation; Task 10 does that in `toolsFor`.
  - `nextStepFor('already_booked', …)` → `{ kind: 'complete', reason: 'already_booked' }`.
  - The outreach-api write-back words map gains `already_booked: 'Already booked'`. It is **not** added to `WRITEBACK_OUTCOMES`.
  - The web label is `'Already booked'`.

- [ ] **Step 1: Write the failing tests** for each line above.
- [ ] **Step 2: Run and see them fail**: `npm test -w services/cti-api -- src/ai-voice/outcomes.test.ts && npm test -w services/outreach-api -- src/ai-calls/outcomes.test.ts`
- [ ] **Step 3: Implement.** TypeScript `Record<AiCallOutcome, …>` maps will point out any other map that needs the new key; fill each one.
- [ ] **Step 4: Run them and see them pass, plus typecheck of cti-api, outreach-api and outreach-web.**
- [ ] **Step 5: Commit**
  ```bash
  git add services/cti-api/src/ai-voice/outcomes.ts services/cti-api/src/ai-voice/outcomes.test.ts services/cti-api/src/ai-voice/store.ts services/cti-api/src/ai-voice/prompt-tools.ts services/outreach-api/src/ai-calls/outcomes.ts services/outreach-api/src/ai-calls/outcomes.test.ts services/outreach-api/src/writeback/context.ts apps/outreach-web/src/lib/call-words.ts
  git commit -m "feat(ai-calls): an already_booked call outcome that completes the touch"
  ```
  Add the web test file you changed as well.

---

### Task 10: cti-api: from the trigger to Sam's booking tools

**Files:**
- Modify: `services/cti-api/src/ai-voice/routes-internal.ts`, `service.ts`, `prompt.ts`, `prompt-context.ts`, `stream-session.ts`, `service-tools.ts`, `service-booking.ts`, `prompt-tools.ts`, `store-booking.ts`, `testing.ts`
- Test: `service-booking.test.ts`, `service-booking-outcome.test.ts`, `prompt-tools` tests (where `toolsFor` is tested), `routes-internal.test.ts`, `store-booking.pg.test.ts` (runs only with `TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `PriorityOffer`, `Consultations`, `PRIORITY_SLOT_ID`, `PRIORITY_RULES`, `CONSULTATION_MINUTES` and `ROUTING_ZONE` (Task 1); `wallTimeToDate` (`local-time.ts`).
- Produces:
  ```ts
  // prompt.ts — PromptInput gains
  consultations?: Consultations;
  priority?: PriorityOffer;
  // prompt-context.ts
  export function promptPriority(priority: PriorityOffer | undefined, address: string | null): PriorityOffer | null;  // null without a street, like walkthrough slots
  // prompt-tools.ts
  export interface BookingTools { slots: readonly AppointmentSlot[]; priority: PriorityOffer | null; alreadyBooked: boolean }
  export function toolsFor(b: BookingTools): RealtimeFunctionTool[];
  export function bookPriorityAppointmentTool(): RealtimeFunctionTool;
  // service-tools.ts — ToolCtx gains
  priority: PriorityOffer | null;
  consultations: Consultations | null;
  // service-booking.ts
  export const PRIORITY_UNAVAILABLE: string; export const PRIORITY_NEEDS_ADDRESS: string; export const PRIORITY_BAD_TIME: string;
  export const PRIORITY_TOO_SOON: string; export const PRIORITY_OUTSIDE_HOURS: string;
  export async function bookPriorityAppointment(args: unknown, env: ToolEnv): Promise<ToolResult>;
  ```
- Plumbing:
  - `startTarget` passes `consultations: t.context?.consultations ?? null` and `priority: t.priority ?? null` for `record`, `practice` and `practice_browser`.
  - `StartInput` gains both.
  - `bookingPrompt` adds `consultations` when `last` or `next` is set. It adds `priority`, plus `sellerTimeZone` as for slots, when priority is present, even with no slots.
  - `stream-session` computes `priority = promptPriority(entry.prompt.priority, entry.prompt.address)`, puts `priority` and `consultations` on `ToolCtx`, and calls `toolsFor({ slots, priority, alreadyBooked: entry.prompt.consultations?.next != null })`.
- **Tools:**
  - `book_appointment` gains a required `what_changed` string: "What has changed since their earlier consultation, in their words; empty when they had none."
  - `book_priority_appointment` has these required params:
    - `start`: "The agreed start as YYYY-MM-DDTHH:MM in Pacific time"
    - `address_confirmed`: boolean
    - `reason`: "Why it is urgent, in their words"
    - `what_changed`
    - `note`

    Its description: "Book a high-priority in-person consultation for a seller who wants to sell as soon as possible or has an urgent situation (a foreclosure, an auction date), at the time they ask for. Call silently after they confirm the property; then confirm the day and time in one line with your goodbye and end_call with outcome appointment_set. If it says the time doesn't work, offer one that does."
  - `toolsFor`: the base tools, plus `book_appointment` when there are slots, plus `book_priority_appointment` when there is a priority offer. `end_call` adds `appointment_set` when there are slots or a priority offer, and `already_booked` when `alreadyBooked` is true.
- **`bookPriorityAppointment` checks, in order:**
  1. `ctx.priority === null` → `PRIORITY_UNAVAILABLE`: "High-priority booking isn't available on this call — nothing was booked. Offer the listed times or a callback."
  2. `address_confirmed !== true` → `PRIORITY_NEEDS_ADDRESS`: "Confirm the property address with them first, then call book_priority_appointment again with address_confirmed true."
  3. `start` doesn't match `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/`, `wallTimeToDate(start, ROUTING_ZONE)` is null, or the minutes are not a multiple of 15 → `PRIORITY_BAD_TIME`: "That time couldn't be read — nothing was booked. Use the date and a time on the quarter hour, in Pacific time, like 2026-10-21T14:00."
  4. Earlier than `now + 120 min` → `PRIORITY_TOO_SOON`: "That's less than two hours away — nothing was booked. Offer a time at least two hours from now."
  5. Local start before 08:00, or start + 60 min after 20:00 → `PRIORITY_OUTSIDE_HOURS`: "The visit has to start at 8 AM or later and finish by 8 PM (latest start 7 PM), any day — nothing was booked. Offer a time in that range."

  It then books `{ slotId: 'h1', kind: 'walkthrough', start, end: start + 60 min, specialistSfUserId: priority.specialistSfUserId, addressConfirmed: true, note: 'Urgent: <reason>. <note>' (one line, ≤ 300), bookedAt, priority: true, whatChanged?, previousConsultation: ctx.consultations?.last ?? undefined }` through `effects.bookAppointment`. The result is today's `BOOKED` words.
- `book_appointment` copies `slot.region`, `whatChanged` (trimmed, ≤ 300, left out when empty) and `previousConsultation`.
- **Store:** `setAppointment` skips the conflict check when `booking.priority === true`, but still takes the lock and the live-row update. The fake store in `testing.ts` follows the same rule.
- **`end_call`:** the `hung_up` rule keeps a booking when `ctx.slots.length > 0 || ctx.priority !== null`.
- **The summary booking line** (`noteBooking`): `Appointment booked: <kind words>[ with <first name>] <ptWords>`. The kind words are `in-person consultation`, `phone consultation` or `high-priority in-person consultation`. The first name is the slot's, or the priority rep's.

- [ ] **Step 1: Write the failing tests** (`now = 2026-10-19T17:00:00Z`, Mon 10:00 PDT; `priority` = Grant):
  - `'2026-10-19T11:30'` → `PRIORITY_TOO_SOON`.
  - `'2026-10-19T12:00'` → booked, with `start '2026-10-19T19:00:00.000Z'`, `end '2026-10-19T20:00:00.000Z'`, `slotId 'h1'`, `priority true` and Grant's id.
  - `'2026-10-24T10:00'` (Saturday) → booked.
  - `'2026-10-20T07:45'` → `PRIORITY_OUTSIDE_HOURS`.
  - `'2026-10-20T19:00'` → booked.
  - `'2026-10-20T19:15'` → `PRIORITY_OUTSIDE_HOURS`.
  - `'2026-10-20T10:10'` → `PRIORITY_BAD_TIME`; `'tomorrow 2pm'` → `PRIORITY_BAD_TIME`.
  - `address_confirmed false` → `PRIORITY_NEEDS_ADDRESS`. `ctx.priority null` → `PRIORITY_UNAVAILABLE`.
  - With `ctx.consultations.last` set, the stored booking's `previousConsultation` equals it and `whatChanged` is trimmed.
  - The fake store books a priority booking over another real call's standing booking for Grant at the same time.
  - `book_appointment` copies `region 'LA'` and `whatChanged`.
  - `toolsFor`:
    - slots only → `book_appointment`, and `end_call` has `appointment_set` but not `already_booked`;
    - priority only → `book_priority_appointment` and `appointment_set`;
    - `alreadyBooked` → `already_booked`, with no booking tools when there are no slots or priority.
  - `routes-internal`: a record target with `priority` and `context.consultations` reaches `startAiCall` with both.
  - `end_call('hung_up')` after a priority booking on a call with no slots → outcome `appointment_set`.

- [ ] **Step 2: Run the tests and see them fail**
  Run: `npm test -w services/cti-api -- src/ai-voice/service-booking.test.ts src/ai-voice/service-booking-outcome.test.ts src/ai-voice/routes-internal.test.ts`
  Expected: FAIL

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the whole cti-api suite and typecheck**
  Run: `npm test -w services/cti-api && npm run typecheck -w services/cti-api`
  Expected: PASS. Prompt golden and snapshot tests are untouched in this task: the instructions don't change until Task 11.

- [ ] **Step 5: Commit** the files listed above, plus the tests you changed.
  ```bash
  git commit -m "feat(ai-voice): Sam books high-priority visits and carries the earlier consultation into a booking"
  ```

---

### Task 11: cti-api: what Sam is told

**Files:**
- Modify: `services/cti-api/src/ai-voice/prompt-booking.ts`, `prompt-view.ts`, `prompt-template.ts` (`PLACEHOLDERS`, `BLOCK_ONLY`, `SAMPLE_INPUT`), `prompt-default-instructions.ts`, `__fixtures__/prompt-golden.json`, `__snapshots__/prompt-first-call.txt` (only if it changes)
- Test: `prompt-template.test.ts`, `prompt-plan.test.ts`, `prompt-booking.test.ts`, `prompt.test.ts`

**Interfaces:**
- Consumes: `PromptInput.consultations` and `PromptInput.priority`, plus `promptPriority` (Task 10).
- Produces:
  - `KIND_WORDS` becomes `{ phone: 'phone consultation', walkthrough: 'in-person consultation' }`.
  - New view values, all strings or booleans, kept frozen and bare like the existing ones:

    | Placeholder | Kind | Value |
    |---|---|---|
    | `had_consultation` | section | an earlier consultation is on file |
    | `last_consultation_when` | text | "March 12", or "March 12, 2025" in another year, in the seller's zone |
    | `last_consultation_with` | shownWhen | first word of `ownerName` ("Blake"), empty when unknown |
    | `last_consultation_in_person` | section | — |
    | `has_booked_consultation` | section | — |
    | `booked_consultation_text` | text | "Wednesday, October 21 at 11 AM with Seth, in person" or "…, by phone"; leave out " with Seth" when unknown |
    | `time_with` | text, inside `appointment_times` | the slot's `specialistFirstName` or '' |
    | `can_book_priority` | section | — |
    | `can_book_any` | section | slots or priority |
    | `priority_specialist_name` | text | — |
    | `priority_default_text` | text | "Tuesday, October 20 at 9 AM", in the seller's zone |

  - Add every new section to `BLOCK_ONLY`. Give each placeholder a one-line description in `PLACEHOLDERS.instructions`.
  - `SAMPLE_INPUT` gains a past consultation (Mar 12, in person, Blake Kossuth) and a priority offer with Grant. Its slots name Blake and Seth and carry `region`.
- **Default template edits (exact copy; nothing outside these blocks changes):**
  1. In `# Role & Objective`, change `{{#can_book}}a booked appointment, {{/can_book}}` to `{{#can_book_any}}a booked appointment, {{/can_book_any}}`.
  2. In `## 4) Hand-off to a specialist`, right after the existing `{{#can_book}}…{{/can_book}}` line, add:
     ```
     {{#can_book_priority}}
     - If they want to sell as soon as possible or something is urgent (a foreclosure, an auction date) and they'd rather book than talk now, offer a visit from {{priority_specialist_name}} (see High priority).
     {{/can_book_priority}}
     ```
  3. Right before `{{#can_book}}\n# Booking an appointment`, add:
     ```
     {{#had_consultation}}
     # Their earlier consultation
     - We've met with them before: {{#last_consultation_in_person}}an in-person consultation{{/last_consultation_in_person}}{{^last_consultation_in_person}}a phone consultation{{/last_consultation_in_person}} on {{last_consultation_when}}{{#last_consultation_with}} with {{last_consultation_with}}{{/last_consultation_with}}.
     - Bring it up yourself, early and warmly — e.g. "I see we {{#last_consultation_in_person}}came out{{/last_consultation_in_person}}{{^last_consultation_in_person}}spoke with you{{/last_consultation_in_person}} back on {{last_consultation_when}} — what's changed since then?"
     - Listen to what changed, then still offer a new consultation. When you book, pass what changed, in their words, as what_changed.

     {{/had_consultation}}
     {{#has_booked_consultation}}
     # Their consultation is already booked
     - They already have a consultation booked: {{booked_consultation_text}}. Don't book another one.
     - Confirm it with them — the day, the time and who it's with — and answer what you can. If that time no longer works, offer to have the team call them to move it (schedule_callback).
     - Then say goodbye and end_call with outcome "already_booked".

     {{/has_booked_consultation}}
     ```
  4. Replace the body of `# Booking an appointment` (between `# Booking an appointment` and `Times you can offer`) with:
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
     - The times are listed right here: offer them straight away. Never say you're checking or thinking about the times.
     - Say a time the way people do — "Thursday at two in the afternoon", "Wednesday the seventh, eleven in the morning". Never read out digits or a date as numbers, and only mention another time zone if they ask.
     - Book only a time from this list, by its id. Never make up a time, and never promise a time you haven't booked.
     - Call book_appointment silently. Then confirm the day, the time and who it's with in ONE line with your goodbye, then end_call with outcome "appointment_set".
     - If book_appointment says that time was just taken, apologise briefly and offer another time from the list.
     - If no time works: schedule_callback instead.
     ```
     The list line becomes `- {{time_id}}: {{time_kind}}{{#time_with}} with {{time_with}}{{/time_with}}, {{time_text}}`.
  5. After the closing `{{/can_book}}` of the Booking section, add:
     ```
     {{#can_book_priority}}
     # High priority
     - Someone is high priority when they want to sell as soon as possible or something is urgent — a foreclosure, an auction date. You judge it from what they tell you.
     - For them, offer an in-person consultation with {{priority_specialist_name}} at the time they ask for: any day, starting between 8 in the morning and 7 at night, at least two hours from now. If they don't name a time, offer {{priority_default_text}}.
     - Confirm the property first ("That's {{the_property}}, right?"), then call book_priority_appointment silently with the agreed time in Pacific time, why it's urgent in their words, and anything {{priority_specialist_name}} should know.
     - Then confirm the day and time in ONE line with your goodbye, and end_call with outcome "appointment_set". If it says the time doesn't work, offer one that does.

     {{/can_book_priority}}
     ```
  6. In `# Tools`:
     - Replace the `book_appointment` line with: `- book_appointment — once they pick one of the offered times (see Booking): slot_id is its id from the list; address_confirmed is true only after they confirmed the property (always for an in-person time); what_changed is what's changed since their earlier consultation, in their words (empty if there was none); note is anything the specialist should know. Call it silently. If it says the time was just taken, offer another time from the list.`
     - Add `{{#can_book_priority}}\n- book_priority_appointment — for a high-priority seller (see High priority): start is the agreed time as YYYY-MM-DDTHH:MM in Pacific time; address_confirmed true once they confirmed the property; reason is why it's urgent; what_changed as for book_appointment; note is anything {{priority_specialist_name}} should know. Call it silently.\n{{/can_book_priority}}`.
     - In the `end_call` line, use `{{#can_book_any}}"appointment_set" (an appointment was booked), {{/can_book_any}}` and add `{{#has_booked_consultation}}"already_booked" (they already had one booked and you confirmed it), {{/has_booked_consultation}}` right after it.

- [ ] **Step 1: Write the failing tests** (`prompt.test.ts`, `prompt-booking.test.ts`):
  - The view with a past consultation `2026-03-12T17:00Z` by Blake Kossuth, in person, and `localTime` in 2026 → `had_consultation true`, `last_consultation_when 'March 12'`, `last_consultation_with 'Blake'`, `last_consultation_in_person true`. In 2025 → `'March 12, 2025'`.
  - Next `2026-10-21T18:00Z`, phone, with Seth Boisvert → `booked_consultation_text 'Wednesday, October 21 at 11 AM with Seth, by phone'`.
  - `time_with` per slot.
  - `priority_default_text` for `2026-10-20T16:00:00.000Z` → `'Tuesday, October 20 at 9 AM'`.
  - `buildInstructions` with an in-person slot `w1` (Blake) and a phone slot `p1` contains:
    - `First offer an in-person consultation`;
    - `- w1: in-person consultation with Blake, `;
    - `Only if they don't want anyone coming out`.
  - Priority only, no slots → contains `# High priority` and not `# Booking an appointment`; `end_call` lists `"appointment_set"`.
  - An upcoming consultation → contains `Don't book another one` and `"already_booked"`.
  - `checkTemplate` accepts a template using every new placeholder, and refuses `{{can_book_priority}}` used as a value, because it is in `BLOCK_ONLY`.
- [ ] **Step 2: Run them and see them fail**: `npm test -w services/cti-api -- src/ai-voice/prompt.test.ts src/ai-voice/prompt-booking.test.ts src/ai-voice/prompt-template.test.ts`
- [ ] **Step 3: Implement the view, the registry and the template edits.**
- [ ] **Step 4: Re-pin the golden fixture deliberately**
  - First run `npm test -w services/cti-api -- src/ai-voice/prompt-template.test.ts`. **Only** golden entries whose `input.slots` is non-empty may fail. If any other entry fails, a template edit leaked outside the booking blocks: fix the template, don't re-pin.
  - Then recompute `instructionsSha256` for exactly those entries with a scratch script that imports `buildInstructions`. Keep the script in the session scratchpad, not the repo. Write the JSON back with the same formatting.
  - Update `__snapshots__/prompt-first-call.txt` only if it has slots and changed, using `npm test -w services/cti-api -- -u src/ai-voice/prompt-plan.test.ts`.
  - Read the snapshot diff before committing.
- [ ] **Step 5: Run the whole cti-api suite and typecheck**: `npm test -w services/cti-api && npm run typecheck -w services/cti-api`. Expected: PASS.
- [ ] **Step 6: Commit**
  ```bash
  git add services/cti-api/src/ai-voice/prompt-booking.ts services/cti-api/src/ai-voice/prompt-view.ts services/cti-api/src/ai-voice/prompt-template.ts services/cti-api/src/ai-voice/prompt-default-instructions.ts services/cti-api/src/ai-voice/__fixtures__/prompt-golden.json services/cti-api/src/ai-voice/prompt.test.ts services/cti-api/src/ai-voice/prompt-booking.test.ts services/cti-api/src/ai-voice/prompt-template.test.ts
  git commit -m "feat(ai-voice): Sam brings up earlier consultations, offers in person first, and books urgent sellers with Grant"
  ```
  Add the snapshot if it changed.

---

### Task 12: The AI calls card: high-priority owner, regions and the Maps key

**Files:**
- Modify: `services/outreach-api/src/writeback/readiness.ts`, `readiness.test.ts`, `services/outreach-api/src/routes/ai-call-settings.ts` (deps gain `maps`), its test, `apps/outreach-web/src/components/ai-call-settings.tsx`, its test, `apps/outreach-web/src/lib/call-words.ts`, its test
- Create: `apps/outreach-web/src/components/booking-regions.tsx`

**Interfaces:**
- Consumes: `RoutingReadiness` (Task 1); `bookingRouting` (Task 3).
- Produces:
  - `writebackReadiness(client, describes, orgId, booking, opts: { mapsConfigured: boolean })` fills `routing`:
    - `{ officeAddress, mapsConfigured, regions: [{ key, counties, startTimes, reps }] }`;
    - reps are read with `readUsers`, in region order;
    - a rep Salesforce doesn't return becomes `{ id, name: id, title: null, isActive: false }`.
  - `appointmentOwner` keeps its meaning in code: the first active person on `specialists`. On the card it is now the **high-priority** person.
  - `RegionsSection({ routing }: { routing: RoutingReadiness })` in `booking-regions.tsx`, which shows:
    - a table with columns Region, Counties, Reps and Starts (Pacific);
    - inactive reps marked "inactive";
    - times shown as "9 AM, 11 AM, 1 PM…";
    - the line "Reps start from the office: <office>.";
    - when `!mapsConfigured`, in destructive text: "Google Maps key missing: no appointment times are offered until GOOGLE_MAPS_API_KEY is set on outreach-api."
- Card copy:
  - The owner list heading becomes "High-priority appointments go to".
  - `OWNER_LINE` becomes "Sellers who need to sell fast, or face a foreclosure or auction, are booked with the first active person on this list at the time they ask for, whatever their calendar says. Every other appointment goes to the region's reps below."
  - `KIND_TITLES` become `{ phone: { offer: 'Offer phone consultations', noun: 'Phone consultation' }, walkthrough: { offer: 'Offer in-person consultations', noun: 'In-person consultation' } }`.
  - `KindFields` keeps the offer switch and the earliest and latest fields. It drops length, from and until: the region table sets them.
  - `RegionsSection` renders under the owner list from the readiness query's `routing`.
- `appointmentWords` in `call-words.ts` uses 'Phone consultation' or 'In-person consultation', and 'High-priority consultation' when `priority`.

- [ ] **Step 1: Write the failing tests**
  - Readiness returns `routing` with both regions and the rep names from a fake `readUsers`. `mapsConfigured` is passed through.
  - The route passes `mapsConfigured: deps.maps !== null`.
  - The card shows "High-priority appointments go to", the LA and SD rows and the Maps-key-missing line when `mapsConfigured` is false. There is no "length (minutes)" input.
  - `appointmentWords({ kind: 'walkthrough', start, priority: true })` starts with "High-priority consultation".
- [ ] **Step 2: Run and see them fail**: `npm test -w services/outreach-api -- src/writeback/readiness.test.ts src/routes && npm test -w apps/outreach-web`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass, plus typecheck of outreach-api and outreach-web.**
- [ ] **Step 5: Commit**
  ```bash
  git add services/outreach-api/src/writeback/readiness.ts services/outreach-api/src/writeback/readiness.test.ts services/outreach-api/src/routes/ai-call-settings.ts apps/outreach-web/src/components/ai-call-settings.tsx apps/outreach-web/src/components/booking-regions.tsx apps/outreach-web/src/lib/call-words.ts
  git commit -m "feat(outreach-web): the AI calls card shows regions, reps, the office and the Maps key"
  ```
  Add the tests you changed as well.

---

### Task 13: Whole-branch check

- [ ] **Step 1: Build packages and run every affected suite and typecheck**
  Run: `npm run build:packages && npm test -w packages/contracts && npm test -w services/outreach-api && npm test -w services/cti-api && npm test -w apps/outreach-web && npm run typecheck -w services/outreach-api && npm run typecheck -w services/cti-api && npm run typecheck -w apps/outreach-web`
  Expected: all PASS. The pass and skip counts are no worse than the baseline taken before Task 1.
- [ ] **Step 2: Grep the diff for logging of seller data**
  Run: `git diff origin/main -- services | grep -nE "log\.(info|warn|error)\(" `
  Check every new log line carries only ids, counts and codes: no `address`, `location`, `Subject`, `name` or URL.
- [ ] **Step 3: Whole-branch review** (superpowers:requesting-code-review). Fix any Critical or Important findings, each with a test.
- [ ] **Step 4: Report to the owner.** Before any push to `main` (which deploys), confirm that `GOOGLE_MAPS_API_KEY` is set on outreach-api and that the owner says go.
