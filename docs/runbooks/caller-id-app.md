# Caller-ID app: TestFlight ship + rep rollout

## What this is

`apps/cti-ios` (target `CTICallerID`, bundle id `com.gghomes.cti.callerid`) is the
rep's iPhone half of caller ID. It pairs with the CTI API, pulls the org's caller
directory, and hands it to iOS as a **Call Directory extension** (target
`CallDirectory`, bundle id `com.gghomes.cti.callerid.directory`) so an inbound
call from a Lead/Opportunity/Deal in Salesforce shows `Lead: Jane Doe` (or
`Opp: …` / `Deal: …`) on the native call screen instead of a bare number. See
`apps/cti-ios/README.md` for the app's own architecture notes — this runbook is
the ship-it-and-turn-it-on process, not a rewrite of that doc.

The directory itself is built server-side:
`services/cti-api/src/mobile/directory-build.ts`'s `buildDirectorySnapshot`
sweeps Salesforce (Leads, primary-Opportunity-contact/account, Deal\_\_c)
every `DIRECTORY_REBUILD_INTERVAL_MS` (default 30 min, plus an immediate
kickoff on server start) and publishes a
versioned snapshot per org into `caller_directory_versions` /
`caller_directory_entries` — one row per label, `Deal: ` > `Opp: ` > `Lead: `
precedence when a number shows up under more than one stage
(`src/mobile/directory-merge.ts`).

**As of this branch, migration `0028_caller_directory.sql` (the
`caller_directory_versions`/`caller_directory_entries`/`mobile_devices`/
`mobile_pair_codes` tables) and the `/mobile/*` routes
(`services/cti-api/src/routes/mobile.ts`) are not live in prod.** Section 2
below is the post-merge, post-deploy check that they actually are before
rolling the app out to reps.

## 1. One-time TestFlight ship

**Preconditions:** a Mac with Xcode installed, signed into Xcode with an Apple
ID that is a member of the Apple Developer Program team this app will ship
under (Account Settings → Team, in Xcode, if you need to check).

1. Open Terminal and run:

   ```bash
   cd apps/cti-ios
   ```

2. If `xcodegen` isn't installed yet:

   ```bash
   brew install xcodegen
   ```

3. Generate the Xcode project. `CTICallerID.xcodeproj` (and the `Info.plist` /
   `.entitlements` files next to the source) are **not** committed to git —
   `project.yml` is the source of truth and this step regenerates them, so run
   it every time after a fresh clone or after `project.yml` changes:

   ```bash
   xcodegen generate
   ```

   This prints `Created project at .../CTICallerID.xcodeproj`.

4. Open the project:

   ```bash
   open CTICallerID.xcodeproj
   ```

5. In Xcode's left sidebar (the Project Navigator), click the blue
   **CTICallerID** project icon at the very top.
6. In the middle pane, under **TARGETS**, click **CTICallerID** (the app —
   the one with the phone icon, not the extension).
7. Click the **Signing & Capabilities** tab at the top of the editor pane.
8. Check **Automatically manage signing** if it isn't already checked, then
   use the **Team** dropdown to pick your Apple Developer team. Xcode shows a
   red "No profiles for … were found" banner until a team is picked — that
   clears once you do.
9. In the same TARGETS list, click **CallDirectory** (the extension) and
   repeat step 7–8 for it, picking the **same** team. **Both targets need a
   signing team** — the archive step below fails if either one is missing it.
   (`CTICallerIDTests` needs no signing; it never ships.)
10. **First ship only — do this BEFORE archiving.** The upload in step 16
    needs an App Store Connect app record for this bundle id to already
    exist; without one Xcode refuses the upload with "No suitable
    application records were found", after the several minutes the archive
    and upload took. So create it now: go to
    [appstoreconnect.apple.com](https://appstoreconnect.apple.com) →
    **Apps** and check whether `CTI Caller ID` is listed. If it isn't:
    **+** → **New App** → platform **iOS**, name `CTI Caller ID`, bundle id
    `com.gghomes.cti.callerid` (pick it from the dropdown — it must match
    exactly), any unique SKU, full access. If the bundle id isn't in the
    dropdown, register it first under **Certificates, Identifiers &
    Profiles → Identifiers**. Later builds skip this step entirely.
11. At the top of the Xcode window, click the scheme selector (next to the
    Stop button) and confirm **CTICallerID** is selected — this scheme
    builds the app + the extension (see `project.yml`'s `schemes:` block).
12. Next to the scheme selector, click the destination/device dropdown and
    choose **Any iOS Device (arm64)**. Archiving is disabled while a
    Simulator destination is selected.
13. From the menu bar: **Product → Archive**. This runs a Release build of
    both targets; it can take a few minutes. If **Archive** is greyed out,
    you still have a Simulator destination selected — go back to step 12.
14. When it finishes, the **Organizer** window opens with the new archive
    listed (today's date/time). If it doesn't auto-open: **Window →
    Organizer**. Select the archive and click **Distribute App**.
15. **App Store Connect** → **Next** → **Upload** → **Next**.
16. Leave the defaults on the remaining screens (automatically manage
    signing, include bitcode/strip symbols options as Xcode presents them) —
    click **Next** through them, then **Upload**. This can take several
    minutes depending on your connection.
17. Back on [appstoreconnect.apple.com](https://appstoreconnect.apple.com),
    open **Apps** → `CTI Caller ID` → **TestFlight** tab. Apple has to
    finish processing the build (usually 10–30 minutes; an email arrives
    when it's ready, or just refresh the tab until the build's status
    leaves "Processing").
18. First build only: TestFlight will ask an **Export Compliance** question.
    This app makes plain HTTPS calls to `AppConfig.baseURL` and stores its
    device token in the Keychain via Apple's own Security framework
    (`apps/cti-ios/App/Keychain.swift`) — no custom cryptography — so answer
    it as standard/exempt encryption.
19. Under **Internal Testing**, create a group if none exists (e.g.
    "Inbound Team"), then click **+** next to **Testers** and add each rep's
    email. This is the same 12-person roster onboarded in
    `services/cti-api/scripts/onboard-inbound-reps.mjs`:

    | Rep | Email |
    | --- | --- |
    | Danny Arredondo | `danny@rethinkreteam.com` |
    | Deivid Lopez | `deivid@rethinkreteam.com` |
    | Edward Jerome Maglalang | `edward@rethinkreteam.com` |
    | Garrett Martorello | `garrettmartorello@gmail.com` |
    | Jordyn Freedman | `jordyn@rethinkreteam.com` |
    | Matt Penrod | `matt@rethinkreteam.com` |
    | Norah Nazzaro | `norahnazzaro@gmail.com` |
    | Samuel Elwood | `sam@rethinkreteam.com` |
    | Seth Boisvert | `greensethb@gmail.com` |
    | Thomas Wilkinson | `thomas@rethinkreteam.com` |
    | Matt Cook | `matt@sjoinvestments.com` |
    | Tyler Lizola | `tyler@sjoinvestments.com` |

20. Select the processed build and **Add to Group**, attaching it to the
    Internal Testing group. Apple emails every tester an invite — first-time
    testers get a link to install the **TestFlight** app, then this build;
    already-invited testers on a later build just get a push notification in
    TestFlight.

**Shipping a later build:** bump `CURRENT_PROJECT_VERSION` in `project.yml`
(currently `"1"`) — App Store Connect rejects re-uploading the same build
number. Re-run `xcodegen generate` (only strictly needed if `project.yml` or
the source-file list changed, but it's cheap and it's what regenerates the
version into the project), then repeat steps 11–16 (scheme, destination,
archive, upload) — step 10 is first-ship only. No need to re-invite testers
already in the group or recreate the app record — once the new build finishes
processing, attach it to the existing Internal Testing group as in step 20,
and testers get an automatic update notification.

## 2. Post-deploy controller checks

Read-only against prod except for the one snapshot write and the one
pairing/device row described below (the device is revoked at the end). Run
these once the branch has merged to `main` and Railway has redeployed
`@cti/api`.

```bash
cd services/cti-api
railway status   # must show project `endearing-comfort` — if not, `railway link` and pick it
```

### 2a. Confirm the deploy actually shipped migration 0028

```bash
PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
DATABASE_URL="$PUB" node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(\"select filename, applied_at from cti_schema_migrations where filename = '0028_caller_directory.sql'\");
  console.log(r.rows);
  await c.end();
})();
"
```

(Same `new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })`
shape `scripts/onboard-inbound-reps.mjs` already uses against this DB.) One row
back means the migration ran. An empty array means the deploy hasn't migrated
yet — stop here and don't proceed to 2b/2c until it has (re-run
`env DATABASE_URL="$PUB" npm run migrate`, or however this repo's deploy
pipeline applies migrations, and re-check).

### 2b. Run one directory snapshot, report version + entry count

There's no packaged CLI for this yet, so this is a small scratch script —
not committed, delete it when you're done. Save it as
`services/cti-api/scripts/_scratch-snapshot-once.ts`:

```ts
/** Scratch, one-off: build the caller directory once for the first org that
 *  has a connected admin, and print { version, entryCount, changed }.
 *  Delete this file after use — it isn't part of the app. */
import { eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../src/db/index.js';
import { pickActingUsers, buildDirectorySnapshot } from '../src/mobile/directory-build.js';

const db = getDb();
const candidates = await db
  .select({ orgId: schema.users.orgId, userId: schema.users.id, isAdmin: schema.users.isAdmin })
  .from(schema.salesforceConnections)
  .innerJoin(schema.users, eq(schema.users.id, schema.salesforceConnections.userId))
  .innerJoin(schema.organizations, eq(schema.organizations.id, schema.users.orgId))
  .where(isNotNull(schema.organizations.sfOrgId));
const [target] = pickActingUsers(candidates);
if (!target) throw new Error('no org has a connected admin — nothing to snapshot');
console.log(await buildDirectorySnapshot(db, target));
process.exit(0);
```

Then run it with the same env pattern the other one-off scripts in this repo
use (`docs/runbooks/number-fleet.md` §1) — Twilio/Salesforce credentials and
config come from the linked `@cti/api` service via `railway run`, the DB is
overridden to the public URL since `railway run` executes locally:

```bash
railway run -s @cti/api -- env DATABASE_URL="$PUB" npx tsx scripts/_scratch-snapshot-once.ts
```

Record the printed `{ version, entryCount, changed }`. `changed: false` on a
repeat run is expected (the content hash hasn't moved) — it still confirms
the pipeline runs end to end.

**Check `entryCount` against the ceiling before rolling the app out.** The
publish caps at 15,000 entries (§7). If `entryCount` comes back at exactly
15,000, the org's real directory is larger than that and the tail is being
dropped — the API logs a
`directory exceeds the Call Directory memory ceiling` warn with the dropped
count. That is not a blocker for the rollout (the labels that do publish are
correct, and it beats a jetsammed extension), but it means §7's streaming
follow-up is now load-bearing. The org's true, uncapped size is the warn's
`swept` field in the `@cti/api` logs — the table only ever holds the
published (capped) count:

```sql
-- the PUBLISHED count (at most 15,000) — the uncapped size is the warn's
-- `swept` field, not this query:
SELECT count(*) FROM caller_directory_entries
WHERE org_id = '<org uuid>' AND version = <the version printed above>;
```

Delete the scratch file when done:

```bash
rm services/cti-api/scripts/_scratch-snapshot-once.ts
```

### 2c. Pair a device with a real code, confirm the feed, revoke it

1. Log into the softphone (the Salesforce-embedded cti-web tab) as any rep in
   the org you just snapshotted, and go to the **Settings** tab (bottom nav,
   person icon) → **Pair your iPhone** card → **Get pairing code**. Note the
   6-digit code — it's live for 5 minutes
   (`apps/cti-web/src/components/MobilePairingCard.tsx`).
2. Claim it exactly like the app does (`POST /mobile/pair/claim`,
   `apps/cti-ios/Shared/PairingClient.swift`):

   ```bash
   curl -s -X POST https://ctiapi-production.up.railway.app/mobile/pair/claim \
     -H 'Content-Type: application/json' \
     -d '{"code":"<the 6 digits>","deviceLabel":"controller-verification"}'
   ```

   A success response is `{"deviceToken": "...", "user": {"displayName": ...}}`.
   Save `deviceToken` — it's a live credential for this "device", same as any
   paired phone's Keychain token.
3. Pull the feed with it (`GET /mobile/caller-directory`,
   `apps/cti-ios/Shared/Feed.swift`) and sum `entries` across every page
   (`FEED_PAGE_SIZE` is 10,000/page):

   ```bash
   curl -s https://ctiapi-production.up.railway.app/mobile/caller-directory \
     -H "Authorization: Bearer <deviceToken>"
   ```

   Confirm the response's `version` matches 2b's `version`, and that the
   total entry count across `pageCount` pages matches 2b's `entryCount`.
   (Optional, closer to how a real phone does it: instead of curl, build and
   run the `CTICallerID` scheme in the iOS Simulator — `AppConfig.baseURL` is
   hardcoded to prod, so no extra config is needed — pair it with a fresh
   code, let it sync, and read `engine.entryCount` off `StatusView`'s
   "Entries" row instead.)
4. Revoke the device. This has to go through the softphone (it's
   session-authed, not device-token-authed — `DELETE /mobile/devices/:id` in
   `services/cti-api/src/routes/mobile.ts` calls `resolveSession`, not
   `resolveDevice`): back in the softphone's Settings tab, find
   `controller-verification` in the paired-devices list and click **Remove**.

## 3. Rep rollout

Send this to each rep once section 1 and 2 are both done:

1. Open the TestFlight invite email (or the TestFlight app if already
   installed) and install **CTI Caller ID**.
2. Open the app. First launch shows the pairing screen.
3. On your computer, open the softphone → **Settings** tab → **Pair your
   iPhone** → **Get pairing code**. You have 5 minutes to use it.
4. On the phone, type the 6 digits into the code field, confirm your device
   name (defaults to your phone's name), and tap **Pair this iPhone**.
5. You land on the status screen and the app pulls your directory
   immediately. If the entry count looks off, pull down to refresh or tap
   **Refresh now**.
6. Turn the extension on (once, by hand — iOS requires this and there's no
   way around it): **Settings → Phone → Call Blocking & Identification →
   CTI Caller ID**, and toggle it on. On **iOS 18 and later** the same screen
   lives under **Settings → Apps → Phone → Call Blocking & Identification**
   (iOS 18 moved per-app settings under "Apps"; on iOS 17, this app's
   deployment target, Phone is at the top level of Settings). The system
   switch turns green when it's on.
7. Back in the CTI Caller ID app, the **Caller ID** row under "iPhone
   setting" should now read **On** instead of **Off** (tap **Refresh now**
   if it hasn't caught up yet — `StatusView` also has an **Open Phone
   settings** button that deep-links straight there if you skipped step 6).

## 4. Acceptance

The only real proof is a physical iPhone receiving a real call — the
Simulator **cannot** show this (there is no real Phone app / CallKit
incoming-call UI in Simulator; see §5 below for what the Simulator can and
can't verify).

1. Confirm the rep's personal cell — the phone with the app installed and
   paired — is set as their no-answer forward number in the softphone
   (**Settings** tab → **Call forwarding**; see
   `apps/cti-web/src/components/SettingsPanel.tsx`).
2. Pick a phone number that is actually in the merged directory (a real
   Lead/Opportunity-contact/Deal\_\_c phone in Salesforce — or query
   `caller_directory_entries` directly for a live `e164`/`label`).
3. From that number, call one of the DIDs assigned to the rep
   (`outbound_numbers.assigned_user_id`). Let it ring unanswered on the
   softphone for the 10-second no-answer window so Twilio forwards it to the
   rep's cell.
4. When the rep's iPhone rings, the native call screen must show
   `Lead: <name>`, `Opp: <name>`, or `Deal: <name>` — never a bare number —
   for that call.

## 5. Troubleshooting

**Label missing on an inbound call**

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Call shows just the raw number | Extension not turned on | Settings → Phone → Call Blocking & Identification → turn CTI Caller ID on (iOS 18+: Settings → Apps → Phone → Call Blocking & Identification) |
| Extension is on, still no label | Directory on the phone is stale | Open the app, pull to refresh, or tap **Refresh now** |
| Refreshed, extension on, still no label | The caller's number isn't a Lead/primary-Opportunity-contact/Deal\_\_c phone in Salesforce, or it failed `normalize()` (invalid numbers are silently dropped — `services/cti-api/src/mobile/directory-build.ts`) | Confirm the number is actually on one of those records/roles |
| Directory version never advances (every phone stuck on the same version for hours despite CRM edits) | The Deal sweep's Id cursor stopped advancing, so every 30-minute tick aborts the whole publish rather than ship a Deal-less snapshot — the only trace is a `CursorPagingError` warn in the `@cti/api` logs each tick | Check the logs for the warn; the cursor bug (usually a Salesforce-side query anomaly) has to be fixed server-side — the phones are behaving correctly by keeping the last good directory |

**Pairing fails**

| Response | Cause | Fix |
| --- | --- | --- |
| "That code is not valid any more. Generate a new one in the softphone." (401) | Code already used, wrong, or its 5-minute TTL passed | Mint a fresh code from the softphone's Settings tab |
| "Too many attempts. Wait a minute and try again." (429) | 3 claim attempts/min/IP, or the 300/min global backstop, tripped (`services/cti-api/src/routes/mobile.ts`) | Wait about a minute and retry |

**What the Simulator can verify, and what it can't.** A Simulator run of the
`CTICallerID` scheme is a legitimate way to check the plumbing above the
Phone app: that pairing/sync work end to end, that `DirectoryStore` loads
without error, that `CXCallDirectoryManager.reloadExtension(withIdentifier:)`
comes back with a result you can inspect, and that `StatusView` reflects it.
What it structurally cannot show is the native call screen overlaying a
label on an incoming call — Simulator has no real Phone app / carrier call
UI for CallKit to draw into. That check is physical-iPhone-only (§4).

## 6. APNs fast-follow (not built yet)

Silent push is a deliberate gap, not an oversight: the app registers **no**
push entitlement and no push handler
(`apps/cti-ios/project.yml` — see the comment on `CTICallerID`'s
`UIBackgroundModes`), and `POST /mobile/apns-token` exists server-side but
nothing ever calls it. Directory updates only arrive on the next foreground
open, pull-to-refresh, or the 4-hour `BGAppRefreshTask` — there is no
"push it the moment the directory changes" path yet.

To close this gap:

1. Create an APNs key (`.p8`) in the Apple Developer account (**Certificates,
   Identifiers & Profiles → Keys**) for `com.gghomes.cti.callerid`.
2. Set it on the server (key id, team id, and the `.p8` contents/path) so
   `@cti/api` can sign push requests to APNs.
3. Add the push notification entitlement and a push-registration/handler to
   the app, and have it call `POST /mobile/apns-token` after registering.

Until then, this is a known, accepted limitation — not a bug to chase.

## 7. Known limits

### The directory is capped at 15,000 entries

**The number:** `MAX_DIRECTORY_ENTRIES = 15_000` in
`services/cti-api/src/mobile/directory-build.ts`, mirrored as
`AppConfig.maxDirectoryEntries` on the phone
(`apps/cti-ios/Shared/AppConfig.swift`). A published version never contains
more; past the cap the server keeps the **lowest-numbered** entries (the merge
is already sorted ascending, so it drops the tail) and logs
`directory exceeds the Call Directory memory ceiling` with the dropped count.
The phone applies the same cap when it writes, as a belt-and-suspenders guard
against a server that ever forgets its own. The read-side cap in
`DirectoryStore.load` only truncates what the extension streams — the decode
of an oversized file has already paid the memory cost by then — so the
server-side cap is the guarantee that matters.

**Why 15,000.** The Call Directory extension decodes the whole snapshot into
memory before streaming it to CallKit, and iOS runs app extensions on a ~12 MB
budget. Measured against this exact snapshot type (a standalone `swiftc -O`
harness, Swift 6.2's rewritten `JSONDecoder`): 20,000 entries (1.1 MB of JSON)
→ 9.5 MB physical footprint; 50,000 → 25.7 MB; 100,000 (5.6 MB JSON) →
49.7 MB — about **0.5 KB of footprint per entry**, ~8.5× the JSON's own size,
most of it decoder transient held as dirty pages, which is exactly what jetsam
bills. With the extension's own CallKit/Foundation baseline counted the breach
point lands around 15–20k, so 15,000 is the last round number that is safely
inside it.

**What going over would have cost.** The failure is total and silent: iOS
jetsams the extension mid-stream, `reloadExtension` comes back with an error,
`SyncEngine` never records the reloaded version so every subsequent
foreground/refresh/background tick relaunches and re-kills it, and **no label
ever appears on any call**. To the rep that is indistinguishable from the
extension being switched off. Capping publishes a partial directory instead —
correct labels for the numbers it does carry.

**The follow-up that lifts it:** make the phone's store streamable rather than
fully decoded — a packed fixed-width binary read via
`Data(contentsOf:options:.mappedIfSafe)` and iterated in place, or a chunked
file set decoded one chunk at a time inside an `autoreleasepool` — and raise
both constants together once the new format is measured. Until then, an org
whose CRM holds more than 15,000 distinct phone numbers gets the lowest-numbered
15,000 of them (see §2b for how to tell).
