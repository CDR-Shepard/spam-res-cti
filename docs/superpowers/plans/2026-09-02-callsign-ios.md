# Callsign for iPhone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Callsign — a native iPhone softphone that rings with the caller's Salesforce name, dials through the existing firewall, wraps up into the existing Salesforce pipeline, and opens records in the Salesforce mobile app.

**Architecture:** The API (`services/cti-api`) gains three small things: an iOS branch on the Twilio token (VoIP push credential), a session-authenticated device-registration route that mints the existing device token (so the directory feed and push-token routes stay device-token-authenticated and unchanged), and a VoIP-token column/route. The app (`apps/cti-ios`, renamed target `Callsign`) keeps its Call Directory extension and adds Salesforce sign-in, a `CallController` state machine over injected Twilio/CallKit protocols, thin live adapters for the Twilio Voice iOS SDK + PushKit + CallKit, and SwiftUI screens. Every compliance decision stays on the server.

**Tech Stack:** TypeScript/Fastify/Drizzle/vitest (API); Swift 5 / SwiftUI / XCTest, xcodegen, Twilio Voice iOS SDK 6.x via SPM, CallKit, PushKit (app).

## Global Constraints

- Product name **Callsign**; app bundle `com.gghomes.callsign`; extension bundle `com.gghomes.callsign.directory`; App Group stays `group.com.gghomes.cti`; iOS deployment target `17.0`; iPhone only (`TARGETED_DEVICE_FAMILY: "1"`); team `CCY3R86SMX`.
- Twilio client identity is `rep_<userId without dashes>` on every platform (web and iOS ring together; first answer wins).
- The app never decides compliance: every outbound dial is `POST /calls` first; a refusal is shown verbatim from the server's `blockReason` and never dialed.
- Records open ONLY via the Salesforce mobile deep link `salesforce1://sObject/<recordId>/view` — no in-app record pages.
- Inbound caller info arrives as Twilio custom parameters `callerName`, `recordId`, `recordType` (shipped separately for the web softphone); absent parameters ⇒ show the formatted number, exactly as today.
- Host-free tests on iOS: every collaborator injected (transport, keychain store, SDK, CallKit), matching `SyncEngine`'s existing pattern. No network, Keychain, or App Group in tests.
- Server tests follow `mobile.test.ts` idioms: Fastify `inject`, `vi.hoisted` state, `vi.mock('../db/index.js')` fake db, `vi.mock('../auth/session.js')`.
- New migrations are additive `IF NOT EXISTS` files numbered from `0035`.
- `.claude/launch.json` is a pre-existing unstaged deletion — never stage, restore, or commit it. No pushes from tasks; the controller pushes after review.
- Secrets never printed; new env var `TWILIO_IOS_PUSH_CREDENTIAL_SID` is optional in config and required only when `platform: 'ios'` is requested.

## Shared interfaces (defined once, used by every task)

**Server**
- `ClientTokenRequest.platform?: 'web' | 'ios'` (`src/telephony/types.ts`).
- `POST /telephony/token` body `{ platform?: 'web'|'ios' }` → existing response `{ token, identity, provider, expiresAt }`.
- `POST /mobile/register` (session bearer) body `{ deviceLabel: string }` → `{ deviceToken: string, deviceId: string }`.
- `POST /mobile/voip-token` (device bearer) body `{ token: string }` → `{ ok: true }`.
- `mobile_devices.voip_token text` (nullable), Drizzle `voipToken`.

**iOS (Swift)**
```swift
struct LoginStart: Decodable, Equatable { let authUrl: URL; let handshake: String }
enum LoginStatus: Equatable { case pending, unknown, failed, done, connected(token: String, expiresAt: String, displayName: String?) }
struct VoiceToken: Decodable, Equatable { let token: String; let expiresAt: String }
struct CallerInfo: Equatable { let number: String; let name: String?; let recordId: String?; let recordType: String?; var displayTitle: String; var displaySubtitle: String? }
enum PlaceCallResult: Equatable { case allowed(callId: String, fromNumber: String); case refused(reason: String) }
struct CallSummary: Decodable, Identifiable, Equatable { let id: String; let direction: String; let toNumber: String; let fromNumber: String?; let disposition: String?; let durationSeconds: Int?; let createdAt: String; let salesforceWhoId: String?; let salesforceWhatId: String? }
protocol VoiceSDK { func register(accessToken: String, deviceToken: Data) async throws; func unregister(accessToken: String, deviceToken: Data) async throws; func connect(accessToken: String, params: [String: String]) async throws -> ActiveCall; func handleIncomingPush(payload: [AnyHashable: Any]) -> IncomingInvite? }
protocol ActiveCall: AnyObject { var uuid: UUID { get }; func hangUp(); func setMuted(_ on: Bool); var onDisconnect: ((Error?) -> Void)? { get set } }
protocol IncomingInvite: AnyObject { var uuid: UUID { get }; var from: String? { get }; var customParameters: [String: String] { get }; func accept() -> ActiveCall; func reject() }
protocol CallSystem { func reportIncoming(uuid: UUID, title: String, handle: String, completion: @escaping (Error?) -> Void); func reportOutgoingStarted(uuid: UUID, handle: String); func reportEnded(uuid: UUID) }  // reportIncoming is SYNCHRONOUS: CallKit must be told before the PushKit delegate returns
```

---

### Task 1: iOS branch on the Twilio access token

**Files:**
- Modify: `services/cti-api/src/config.ts:59` (add `TWILIO_IOS_PUSH_CREDENTIAL_SID: z.string().optional()` after `TWILIO_TWIML_APP_SID`)
- Modify: `services/cti-api/src/telephony/types.ts:17-23`
- Modify: `services/cti-api/src/telephony/twilio.ts:39-77`
- Modify: `services/cti-api/src/routes/telephony.ts:29-42`
- Test: `services/cti-api/src/telephony/twilio.test.ts` (create if absent), `services/cti-api/src/routes/telephony-token.test.ts` (create)

**Interfaces:**
- Produces: `ClientTokenRequest.platform?: 'web' | 'ios'`; token route accepts `{ platform }` body; iOS grants carry `pushCredentialSid`.

- [ ] **Step 1: Write the failing provider test**

```ts
// services/cti-api/src/telephony/twilio.test.ts
import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_KEY_SID: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_KEY_SECRET: 'secretsecretsecretsecretsecret12',
    TWILIO_TWIML_APP_SID: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_IOS_PUSH_CREDENTIAL_SID: 'CRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  }),
}));

import { TwilioProvider } from './twilio.js';

function voiceGrant(token: string): Record<string, unknown> {
  const decoded = jwt.decode(token) as { grants: { voice: Record<string, unknown> } };
  return decoded.grants.voice;
}

describe('createClientToken platform branch', () => {
  it('web tokens carry no push credential', async () => {
    const res = await new TwilioProvider().createClientToken({ userId: 'u1', identity: 'rep_u1' });
    expect(voiceGrant(res.token).push_credential_sid).toBeUndefined();
  });
  it('ios tokens carry the VoIP push credential', async () => {
    const res = await new TwilioProvider().createClientToken({ userId: 'u1', identity: 'rep_u1', platform: 'ios' });
    expect(voiceGrant(res.token).push_credential_sid).toBe('CRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(voiceGrant(res.token).incoming).toEqual({ allow: true });
  });
});
```

Read `src/telephony/twilio.ts:1-40` first for the exported class name; if it is not `TwilioProvider`, use the real export.

- [ ] **Step 2: Run to confirm failure**

Run: `cd services/cti-api && npx vitest run src/telephony/twilio.test.ts`
Expected: FAIL — `push_credential_sid` undefined on the ios case (platform is ignored today).

- [ ] **Step 3: Implement**

`src/telephony/types.ts` — add to `ClientTokenRequest`:
```ts
  /** Which client is asking. iOS tokens carry the VoIP push credential so a locked phone can be rung. */
  platform?: 'web' | 'ios';
```

`src/telephony/twilio.ts` — replace the grant construction:
```ts
    if (req.platform === 'ios' && !cfg.TWILIO_IOS_PUSH_CREDENTIAL_SID) {
      throw new Error('TWILIO_IOS_PUSH_CREDENTIAL_SID is not configured — iOS clients cannot register for VoIP push');
    }
    const grant = new VoiceGrant({
      outgoingApplicationSid: cfg.TWILIO_TWIML_APP_SID!,
      incomingAllow: true,
      // A locked iPhone is reachable only through APNs VoIP push; the credential
      // ties this token to the Apple VoIP Services certificate registered in Twilio.
      ...(req.platform === 'ios' ? { pushCredentialSid: cfg.TWILIO_IOS_PUSH_CREDENTIAL_SID! } : {}),
    });
```

`src/config.ts` — after `TWILIO_TWIML_APP_SID`:
```ts
  /** Twilio Push Credential (APNs VoIP) for the Callsign iPhone app. Optional until the app ships. */
  TWILIO_IOS_PUSH_CREDENTIAL_SID: z.string().optional(),
```

`src/routes/telephony.ts:29` — parse an optional body and forward it:
```ts
  const TokenBody = z.object({ platform: z.enum(['web', 'ios']).optional() });
  app.post('/telephony/token', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const body = TokenBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const provider = getProvider();
    try {
      const token = await provider.createClientToken({
        userId: session.userId,
        identity: `rep_${session.userId.replace(/-/g, '')}`,
        platform: body.data.platform,
      });
      return token;
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });
```
(`z` is already imported in that file — check; add `import { z } from 'zod'` if not.)

- [ ] **Step 4: Route test (RED then GREEN)**

```ts
// services/cti-api/src/routes/telephony-token.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const state = vi.hoisted(() => ({ lastReq: null as Record<string, unknown> | null }));
vi.mock('../auth/session.js', () => ({ resolveSession: async () => ({ userId: 'aaaa-bbbb', orgId: 'o', email: 'e', isAdmin: false, powerDialerEnabled: false }) }));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    createClientToken: async (req: Record<string, unknown>) => { state.lastReq = req; return { token: 't', identity: req.identity, provider: 'twilio', expiresAt: 'x' }; },
    validateWebhook: () => ({ valid: true }),
  }),
}));
import { registerTelephonyRoutes } from './telephony.js';

describe('POST /telephony/token platform', () => {
  beforeEach(() => { state.lastReq = null; });
  async function app() { const f = Fastify(); await registerTelephonyRoutes(f); return f; }
  it('forwards platform=ios', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' }, payload: { platform: 'ios' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastReq).toMatchObject({ platform: 'ios', identity: 'rep_aaaabbbb' });
  });
  it('defaults to no platform for the web softphone (empty body)', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastReq?.platform).toBeUndefined();
  });
  it('rejects an unknown platform', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' }, payload: { platform: 'android' } });
    expect(res.statusCode).toBe(400);
  });
});
```
Check the real names: the routes file's register function and the provider module path (`grep -n 'export' src/routes/telephony.ts src/telephony/index.ts`). Use those.

Run: `npx vitest run src/routes/telephony-token.test.ts src/telephony/twilio.test.ts` → PASS.

- [ ] **Step 5: Full gates + commit**

Run: `npx tsc --noEmit && npm test` → all green (baseline 747 + new).
```bash
git add src/config.ts src/telephony/types.ts src/telephony/twilio.ts src/routes/telephony.ts src/telephony/twilio.test.ts src/routes/telephony-token.test.ts
git commit -m "feat(cti-api): iOS voice tokens carry the VoIP push credential"
```

---

### Task 2: VoIP token storage + route

**Files:**
- Create: `services/cti-api/migrations/0035_mobile_voip_token.sql`
- Modify: `services/cti-api/src/db/schema.ts:817` (add `voipToken` beside `apnsToken`)
- Modify: `services/cti-api/src/routes/mobile.ts:414-424` (add the route after `/mobile/apns-token`)
- Test: `services/cti-api/src/routes/mobile.test.ts` (extend)

**Interfaces:**
- Produces: `POST /mobile/voip-token` (device bearer) `{ token }` → `{ ok: true }`; column `mobile_devices.voip_token`.

- [ ] **Step 1: Failing route test** — add to `mobile.test.ts`, mirroring the existing `/mobile/apns-token` test (find it with `grep -n apns-token src/routes/mobile.test.ts`; copy its shape exactly, changing the path to `/mobile/voip-token` and asserting `state.lastUpdateValues` equals `{ voipToken: 'pk-token-123' }`).

- [ ] **Step 2: Run** `npx vitest run src/routes/mobile.test.ts -t voip` → FAIL (404).

- [ ] **Step 3: Implement**

`migrations/0035_mobile_voip_token.sql`:
```sql
-- Callsign iPhone app: PushKit VoIP token per device (Twilio delivers the ring;
-- we keep the token for device management). Additive; apns_token stays for the
-- deferred silent-push feature.
alter table mobile_devices add column if not exists voip_token text;
```
`schema.ts` after `apnsToken`: `voipToken: text('voip_token'),`

`mobile.ts` after the apns-token route:
```ts
  const VoipTokenBody = z.object({ token: z.string().min(16).max(512) });
  app.post('/mobile/voip-token', async (req, reply) => {
    const device = await resolveDevice(req.headers.authorization);
    if (!device) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = VoipTokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    await db.update(schema.mobileDevices).set({ voipToken: parsed.data.token, lastSeenAt: new Date() }).where(eq(schema.mobileDevices.id, device.id));
    return { ok: true };
  });
```

- [ ] **Step 4: Run** the test → PASS. Then `npx tsc --noEmit && npm test` → green.

- [ ] **Step 5: Commit**
```bash
git add migrations/0035_mobile_voip_token.sql src/db/schema.ts src/routes/mobile.ts src/routes/mobile.test.ts
git commit -m "feat(cti-api): store the iPhone's VoIP push token per device"
```

---

### Task 3: Session-authenticated device registration

**Files:**
- Modify: `services/cti-api/src/routes/mobile.ts` (new route next to `/mobile/pair/claim` ~:286; extract the device-token mint the claim route uses into `mintDeviceToken()` if it is inline)
- Test: `services/cti-api/src/routes/mobile.test.ts` (extend)

**Interfaces:**
- Produces: `POST /mobile/register` (session bearer) `{ deviceLabel }` → `{ deviceToken, deviceId }`. The returned token is the SAME kind of device token pairing mints, so `/mobile/caller-directory`, `/mobile/apns-token`, `/mobile/voip-token` need no changes.

- [ ] **Step 1: Read** `mobile.ts:286-352` (claim route) and note exactly how it generates the raw token and its hash (`sha256`). If it is inline, extract:
```ts
/** A fresh device token + the hash we store; the raw token is returned to the phone once and never persisted. */
function mintDeviceToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}
```
and make the claim route call it (behavior unchanged — existing claim tests must stay green).

- [ ] **Step 2: Failing tests** (append to `mobile.test.ts`):
```ts
describe('POST /mobile/register', () => {
  it('mints a device token for the signed-in user', async () => {
    state.authedUser = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false };
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer session' }, payload: { deviceLabel: 'iPhone (Callsign)' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.deviceId).toBeTruthy();
    expect(state.deviceInsertCount).toBe(1);
  });
  it('401 without a session', async () => {
    state.authedUser = null;
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer x' }, payload: { deviceLabel: 'iPhone' } });
    expect(res.statusCode).toBe(401);
  });
  it('400 on a missing label', async () => {
    state.authedUser = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false };
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer session' }, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
```
Use the file's existing `app` fixture variable and `state` names (read the top of the file); the fake db's insert must `.returning()` an id — check how `deviceInsertCount` is wired for the claim test and reuse it.

- [ ] **Step 3: Run** → FAIL (404). **Implement**:
```ts
  const RegisterBody = z.object({ deviceLabel: z.string().trim().min(1).max(120) });
  app.post('/mobile/register', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { raw, hash } = mintDeviceToken();
    const db = getDb();
    const [row] = await db
      .insert(schema.mobileDevices)
      .values({ userId: session.userId, tokenHash: hash, label: parsed.data.deviceLabel })
      .returning({ id: schema.mobileDevices.id });
    req.log.info({ userId: session.userId, deviceId: row.id }, 'mobile device registered via session');
    return { deviceToken: raw, deviceId: row.id };
  });
```
`resolveSession` is already imported in mobile.ts (it powers pair/start) — verify.

- [ ] **Step 4: Run** `npx vitest run src/routes/mobile.test.ts` → all PASS (incl. existing claim tests). `npx tsc --noEmit && npm test` → green.

- [ ] **Step 5: Commit**
```bash
git add src/routes/mobile.ts src/routes/mobile.test.ts
git commit -m "feat(cti-api): session-authenticated device registration for the Callsign app"
```

---

### Task 4: Project rename, capabilities, SDK dependency, managed config

**Files:**
- Modify: `apps/cti-ios/project.yml` (targets/bundles/capabilities/SPM)
- Modify: `apps/cti-ios/Shared/AppConfig.swift`
- Create: `apps/cti-ios/Tests/AppConfigTests.swift`
- Modify: `apps/cti-ios/README.md` (title + target names)

**Interfaces:**
- Produces: `AppConfig.baseURL` resolved at runtime via `AppConfig.resolveBaseURL(managed:)`; `AppConfig.keychainService = "com.gghomes.callsign"`; `AppConfig.extensionBundleIdentifier = "com.gghomes.callsign.directory"`; target names `Callsign`, `CallDirectory`, `CallsignTests`.

- [ ] **Step 1: Failing test**
```swift
// Tests/AppConfigTests.swift
import XCTest

final class AppConfigTests: XCTestCase {
    func testManagedConfigOverridesBaseURL() {
        let url = AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "https://cti.example.test"])
        XCTAssertEqual(url, URL(string: "https://cti.example.test")!)
    }
    func testMissingOrBadManagedValueFallsBackToProduction() {
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: nil), AppConfig.productionBaseURL)
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "not a url"]), AppConfig.productionBaseURL)
        XCTAssertEqual(AppConfig.resolveBaseURL(managed: ["apiBaseUrl": "http://insecure.example"]), AppConfig.productionBaseURL)
    }
}
```

- [ ] **Step 2: Run** `cd apps/cti-ios && xcodegen generate && xcodebuild test -project Callsign.xcodeproj -scheme CallsignTests -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:CallsignTests/AppConfigTests` → FAIL to compile (`resolveBaseURL` missing). (The scheme/project names come from Step 3; do Step 3's project.yml edit first if xcodegen refuses.)

- [ ] **Step 3: Implement**

`AppConfig.swift` — replace the fixed `baseURL`:
```swift
    /// Production API. The phone is still not a place to type a server URL —
    /// but Mosyle can push one through Managed App Configuration
    /// (`com.apple.configuration.managed` → `apiBaseUrl`), which is how a
    /// staging build or a future region gets pointed elsewhere.
    static let productionBaseURL = URL(string: "https://ctiapi-production.up.railway.app")!

    static var baseURL: URL {
        resolveBaseURL(managed: UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed"))
    }

    /// Pure: only an https URL from managed config wins; anything else is production.
    static func resolveBaseURL(managed: [String: Any]?) -> URL {
        guard let raw = managed?["apiBaseUrl"] as? String,
              let url = URL(string: raw), url.scheme == "https", url.host != nil else { return productionBaseURL }
        return url
    }
```
Update the identifiers: `extensionBundleIdentifier = "com.gghomes.callsign.directory"`, `backgroundRefreshTaskIdentifier = "com.gghomes.callsign.refresh"`, `keychainService = "com.gghomes.callsign"`, `loggingSubsystem = "com.gghomes.callsign"`. App Group stays `group.com.gghomes.cti`.

`project.yml`: rename `name: Callsign`; target `CTICallerID` → `Callsign` with `PRODUCT_BUNDLE_IDENTIFIER: com.gghomes.callsign`, `CFBundleDisplayName: Callsign`, `UIBackgroundModes: [voip, audio, fetch]`, `BGTaskSchedulerPermittedIdentifiers: [com.gghomes.callsign.refresh]`, entitlements add `aps-environment: production`; extension bundle `com.gghomes.callsign.directory`, display name `Callsign`; tests target `CallsignTests` bundle `com.gghomes.callsign.tests` (sources list: keep the existing ones and add the new files as later tasks create them — each later task appends its files here); provisioning profile specifiers renamed `Callsign AppStore` / `Callsign Directory AppStore` (the profiles themselves are created in the release runbook, Task 12). Add the SPM package:
```yaml
packages:
  TwilioVoice:
    url: https://github.com/twilio/twilio-voice-ios
    from: "6.0.0"
```
and under the `Callsign` target `dependencies: [{ target: CallDirectory }, { package: TwilioVoice, product: TwilioVoice }]`. Rename schemes to `Callsign` / `CallsignTests`. Update the two `NSExtensionPrincipalClass`-adjacent display names. Rename the entitlements/plist paths only if you rename the directories — keep `App/` and `CallDirectory/` directories as they are.

- [ ] **Step 4: Run** the AppConfig tests → PASS; then the whole `Callsign` scheme test → all existing tests still PASS.

- [ ] **Step 5: Commit**
```bash
git add apps/cti-ios/project.yml apps/cti-ios/Shared/AppConfig.swift apps/cti-ios/Tests/AppConfigTests.swift apps/cti-ios/README.md
git commit -m "feat(callsign): rename the iOS app to Callsign, add VoIP capabilities and managed config"
```

---

### Task 5: Salesforce sign-in client + session store

**Files:**
- Create: `apps/cti-ios/Shared/SessionClient.swift`
- Create: `apps/cti-ios/App/SessionTokenStore.swift`
- Create: `apps/cti-ios/Tests/SessionClientTests.swift`
- Modify: `apps/cti-ios/project.yml` (add the three files to `CallsignTests` sources; `Shared/SessionClient.swift` also to the app — `Shared/` is already an app source path)

**Interfaces:**
- Produces: `loginStartRequest(baseURL:)`, `loginStatusRequest(baseURL:handshake:)`, `decodeLoginStart(_:status:) throws -> LoginStart`, `decodeLoginStatus(_:status:) throws -> LoginStatus`, `SignInPoller` (below), `SessionTokenStore` with `load/save/delete` mirroring `DeviceTokenStore` (Keychain account `"session-token"`).

- [ ] **Step 1: Failing tests**
```swift
// Tests/SessionClientTests.swift
import XCTest

final class SessionClientTests: XCTestCase {
    let base = URL(string: "https://api.example.test")!

    func testStartRequestIsPostToLoginStart() throws {
        let req = try loginStartRequest(baseURL: base)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/auth/salesforce/login/start")
    }
    func testDecodeStart() throws {
        let data = #"{"authUrl":"https://login.salesforce.com/x","handshake":"hs_12345678"}"#.data(using: .utf8)!
        let start = try decodeLoginStart(data, status: 200)
        XCTAssertEqual(start.handshake, "hs_12345678")
        XCTAssertEqual(start.authUrl, URL(string: "https://login.salesforce.com/x"))
    }
    func testDecodeStatusVariants() throws {
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"pending"}"#.data(using: .utf8)!, status: 200), .pending)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"failed"}"#.data(using: .utf8)!, status: 200), .failed)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"done"}"#.data(using: .utf8)!, status: 200), .done)
        XCTAssertEqual(try decodeLoginStatus(#"{"status":"unknown"}"#.data(using: .utf8)!, status: 200), .unknown)
        let connected = #"{"status":"connected","token":"sess_abc","expiresAt":"2026-09-03T00:00:00Z","user":{"id":"u","email":"e","displayName":"Jane Rep","orgId":"o"}}"#.data(using: .utf8)!
        XCTAssertEqual(try decodeLoginStatus(connected, status: 200), .connected(token: "sess_abc", expiresAt: "2026-09-03T00:00:00Z", displayName: "Jane Rep"))
    }
    func testPollerReturnsTokenWhenConnectedAndStopsOnFailure() async throws {
        var answers: [LoginStatus] = [.pending, .pending, .connected(token: "sess_abc", expiresAt: "x", displayName: nil)]
        let poller = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 10,
                                  status: { _ in answers.removeFirst() }, sleep: { _ in })
        let result = try await poller.run()
        XCTAssertEqual(result, .connected(token: "sess_abc", expiresAt: "x", displayName: nil))

        var failing: [LoginStatus] = [.pending, .failed]
        let p2 = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 10, status: { _ in failing.removeFirst() }, sleep: { _ in })
        XCTAssertEqual(try await p2.run(), .failed)
    }
    func testPollerGivesUpAfterMaxAttempts() async throws {
        let p = SignInPoller(handshake: "hs", interval: 0, maxAttempts: 3, status: { _ in .pending }, sleep: { _ in })
        await XCTAssertThrowsErrorAsync(try await p.run())
    }
}

func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do { _ = try await expression(); XCTFail("expected throw", file: file, line: line) } catch {}
}
```

- [ ] **Step 2: Run** the test target → FAIL to compile.

- [ ] **Step 3: Implement**
```swift
// Shared/SessionClient.swift
import Foundation

struct LoginStart: Decodable, Equatable { let authUrl: URL; let handshake: String }

enum LoginStatus: Equatable {
    case pending, unknown, failed, done
    case connected(token: String, expiresAt: String, displayName: String?)
}

enum SessionClientError: LocalizedError, Equatable {
    case server(status: Int), malformedResponse, timedOut
    var errorDescription: String? {
        switch self {
        case let .server(status): return "The server refused the sign-in (HTTP \(status))."
        case .malformedResponse: return "The server sent an unexpected response."
        case .timedOut: return "Sign-in took too long. Try again."
        }
    }
}

func loginStartRequest(baseURL: URL) throws -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent("auth/salesforce/login/start"))
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = Data("{}".utf8)
    return r
}

func loginStatusRequest(baseURL: URL, handshake: String) -> URLRequest {
    var c = URLComponents(url: baseURL.appendingPathComponent("auth/salesforce/login/status"), resolvingAgainstBaseURL: false)!
    c.queryItems = [URLQueryItem(name: "handshake", value: handshake)]
    return URLRequest(url: c.url!)
}

func decodeLoginStart(_ data: Data, status: Int) throws -> LoginStart {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let s = try? JSONDecoder().decode(LoginStart.self, from: data) else { throw SessionClientError.malformedResponse }
    return s
}

private struct StatusWire: Decodable {
    struct User: Decodable { let displayName: String? }
    let status: String; let token: String?; let expiresAt: String?; let user: User?
}

func decodeLoginStatus(_ data: Data, status: Int) throws -> LoginStatus {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let w = try? JSONDecoder().decode(StatusWire.self, from: data) else { throw SessionClientError.malformedResponse }
    switch w.status {
    case "pending": return .pending
    case "failed": return .failed
    case "done": return .done
    case "connected":
        guard let t = w.token, let e = w.expiresAt else { throw SessionClientError.malformedResponse }
        return .connected(token: t, expiresAt: e, displayName: w.user?.displayName)
    default: return .unknown
    }
}

/// Polls login/status until it resolves. Injected status + sleep so the state
/// machine is testable without a network or a clock.
struct SignInPoller {
    typealias StatusFetch = (_ handshake: String) async throws -> LoginStatus
    typealias Sleep = (_ seconds: TimeInterval) async -> Void
    let handshake: String
    var interval: TimeInterval = 2
    var maxAttempts: Int = 150 // ~5 minutes at 2s; the server's state expires at 10
    let status: StatusFetch
    let sleep: Sleep

    func run() async throws -> LoginStatus {
        for _ in 0..<maxAttempts {
            let s = try await status(handshake)
            switch s {
            case .pending, .unknown: await sleep(interval)
            case .failed, .done, .connected: return s
            }
        }
        throw SessionClientError.timedOut
    }
}

/// Live transport for the two sign-in requests.
func liveLoginStatus(baseURL: URL) -> SignInPoller.StatusFetch {
    { handshake in
        let (data, resp) = try await URLSession.shared.data(for: loginStatusRequest(baseURL: baseURL, handshake: handshake))
        return try decodeLoginStatus(data, status: (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
```
```swift
// App/SessionTokenStore.swift — same shape as DeviceTokenStore, account "session-token".
import Foundation
import Security

enum SessionTokenStore {
    private static let account = "session-token"
    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: AppConfig.keychainService, kSecAttrAccount as String: account]
    }
    static func save(_ token: String) throws {
        SecItemDelete(baseQuery as CFDictionary)
        var q = baseQuery
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }
    static func load() -> String? {
        var q = baseQuery; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete() { SecItemDelete(baseQuery as CFDictionary) }
}
```

- [ ] **Step 4: Run** tests → PASS. **Step 5: Commit** `feat(callsign): Salesforce sign-in client and session store`.

---

### Task 6: Sign-in screen + device registration

**Files:**
- Create: `apps/cti-ios/App/SignInView.swift`
- Create: `apps/cti-ios/Shared/DeviceRegistrationClient.swift`
- Create: `apps/cti-ios/Tests/DeviceRegistrationClientTests.swift`
- Modify: `apps/cti-ios/App/CTIApp.swift` (route: no session → `SignInView`; else the main tab UI from Task 10; until Task 10 exists, show `StatusView`)
- Modify: `apps/cti-ios/App/SyncEngine.swift` (add `adoptDeviceToken(_:displayName:)` that stores via `tokens.save` and sets `isPaired`; keep `pair(code:)` for legacy)
- Modify: `apps/cti-ios/project.yml` (test sources)

**Interfaces:**
- Produces: `registerDeviceRequest(baseURL:sessionToken:label:)`, `decodeRegistration(_:status:) -> DeviceRegistration { deviceToken, deviceId }`, `SyncEngine.adoptDeviceToken(_ token: String, displayName: String?)`.

- [ ] **Step 1: Failing tests**
```swift
// Tests/DeviceRegistrationClientTests.swift
import XCTest
final class DeviceRegistrationClientTests: XCTestCase {
    func testRequestCarriesSessionBearerAndLabel() throws {
        let req = try registerDeviceRequest(baseURL: URL(string: "https://api.example.test")!, sessionToken: "sess_1", label: "Jane's iPhone")
        XCTAssertEqual(req.url?.path, "/mobile/register")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess_1")
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: String]
        XCTAssertEqual(body["deviceLabel"], "Jane's iPhone")
    }
    func testDecode() throws {
        let ok = try decodeRegistration(#"{"deviceToken":"dev_abc","deviceId":"d1"}"#.data(using: .utf8)!, status: 200)
        XCTAssertEqual(ok, DeviceRegistration(deviceToken: "dev_abc", deviceId: "d1"))
        XCTAssertThrowsError(try decodeRegistration(Data(), status: 401))
    }
}
```
Plus in `SyncEngineTests.swift`: `adoptDeviceToken("dev_abc", displayName: "Jane")` → `isPaired == true`, `pairedUserName == "Jane"`, and the injected `tokens.save` received `"dev_abc"` (mirror the existing pair(code:) test's fake TokenStore).

- [ ] **Step 2: Run** → compile failure. **Step 3: Implement**
```swift
// Shared/DeviceRegistrationClient.swift
import Foundation
struct DeviceRegistration: Decodable, Equatable { let deviceToken: String; let deviceId: String }
private struct RegisterBody: Encodable { let deviceLabel: String }
func registerDeviceRequest(baseURL: URL, sessionToken: String, label: String) throws -> URLRequest {
    var r = URLRequest(url: baseURL.appendingPathComponent("mobile/register"))
    r.httpMethod = "POST"
    r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
    r.httpBody = try JSONEncoder().encode(RegisterBody(deviceLabel: label))
    return r
}
func decodeRegistration(_ data: Data, status: Int) throws -> DeviceRegistration {
    guard status == 200 else { throw SessionClientError.server(status: status) }
    guard let d = try? JSONDecoder().decode(DeviceRegistration.self, from: data) else { throw SessionClientError.malformedResponse }
    return d
}
```
`SyncEngine.adoptDeviceToken`:
```swift
    /// Sign-in path: the app already holds a session and asked the server to
    /// mint a device token for this phone — no 6-digit code involved.
    func adoptDeviceToken(_ token: String, displayName: String?) throws {
        try tokens.save(token)
        defaults.set(displayName, forKey: Keys.pairedUserName)
        pairedUserName = displayName
        isPaired = true
    }
```
`SignInView`: one "Sign in with Salesforce" button → `loginStartRequest` via `URLSession` → `ASWebAuthenticationSession(url: authUrl, callbackURLScheme: nil)` (the callback lands on the API's own page; the poller is the completion signal) → `SignInPoller(handshake:…, status: liveLoginStatus(baseURL:), sleep: { try? await Task.sleep(for: .seconds($0)) }).run()` → on `.connected`: `SessionTokenStore.save(token)`, then `registerDeviceRequest` with label `"\(UIDevice.current.name) (Callsign)"` → `SyncEngine.shared.adoptDeviceToken(...)`. Show errors with `errorDescription`. `CTIApp.swift`: `SessionTokenStore.load() == nil ? SignInView() : StatusView()` (Task 10 replaces `StatusView()` with the tab UI).

- [ ] **Step 4: Run** all tests → PASS; build the app scheme → compiles. **Step 5: Commit** `feat(callsign): sign in with Salesforce and self-register the device`.

---

### Task 7: Voice token + calls API clients

**Files:**
- Create: `apps/cti-ios/Shared/VoiceTokenClient.swift`, `apps/cti-ios/Shared/CallsAPI.swift`
- Create: `apps/cti-ios/Tests/CallsAPITests.swift`
- Modify: `apps/cti-ios/project.yml` (test sources)

**Interfaces:**
- Produces: `voiceTokenRequest(baseURL:sessionToken:)` → body `{"platform":"ios"}`; `decodeVoiceToken(_:status:) -> VoiceToken`; `placeCallRequest(baseURL:sessionToken:toNumber:)`; `decodePlaceCall(_:status:) -> PlaceCallResult`; `dispositionRequest(baseURL:sessionToken:callId:disposition:notes:)`; `recentCallsRequest(baseURL:sessionToken:limit:)`; `decodeRecentCalls(_:status:) -> [CallSummary]`; `pendingDispositionRequest(baseURL:sessionToken:)` → `decodePendingDisposition -> CallSummary?`.

- [ ] **Step 1: Read the server contracts first** — `services/cti-api/src/routes/calls.ts:162-340` (POST /calls: the success body and the refusal body/status), `:468-566` (disposition body fields), `:375-382` (pending-disposition shape). Write the test fixtures from what the handler actually returns (copy the exact keys). The refusal decoder must map: a non-2xx with a JSON `blockReason` or `error` → `.refused(reason)`, preferring `blockReason`.

- [ ] **Step 2: Failing tests** (`CallsAPITests.swift`): request shape tests for each builder (method, path, bearer, body keys); `decodeVoiceToken` happy + 503; `decodePlaceCall` allowed (fixture from the handler) and refused (`{"error":"…","blockReason":"Calling FL is Mon-Sat only (today is Sunday, recipient-local)"}` with status 409 → `.refused(reason: "Calling FL is Mon-Sat only (today is Sunday, recipient-local)")`); `decodeRecentCalls` parses the `calls` array from the handler's `{ calls: [...] }` envelope; pending-disposition `null`/object.

- [ ] **Step 3: Implement** both files as pure builders/decoders in the `PairingClient` style (`URLRequest` builders + `decode(_:status:)` functions + a shared `authedRequest(baseURL:path:sessionToken:)` helper). All bodies JSON; all decoders throw `SessionClientError.server(status:)` on non-2xx unless the status is a refusal the caller must render.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(callsign): voice-token and calls API clients`.

---

### Task 8: CallController state machine over injected SDK/CallKit

**Files:**
- Create: `apps/cti-ios/App/CallController.swift`
- Create: `apps/cti-ios/App/CallerInfo.swift`
- Create: `apps/cti-ios/Tests/CallerInfoTests.swift`, `apps/cti-ios/Tests/CallControllerTests.swift`
- Modify: `apps/cti-ios/project.yml` (test sources: add the two App files + tests)

**Interfaces:**
- Produces: the protocols from "Shared interfaces" (`VoiceSDK`, `ActiveCall`, `IncomingInvite`, `CallSystem`), `CallerInfo(number:name:recordId:recordType:)` with `.from(customParameters:from:)`, `CallController` (`@MainActor ObservableObject`) with `enum Phase { idle, ringing(CallerInfo), dialing(CallerInfo), active(CallerInfo, since: Date), wrapup(callId: String?, CallerInfo) }`, methods `handleIncomingPush(_:)`, `answer()`, `decline()`, `placeCall(to:)`, `hangUp()`, `setMuted(_:)`, `finishWrapup(disposition:notes:)`, `skipWrapup()`, and `lastRefusal: String?`.

- [ ] **Step 1: Failing tests**
```swift
// Tests/CallerInfoTests.swift
import XCTest
final class CallerInfoTests: XCTestCase {
    func testMatchedCallerShowsNameAndType() {
        let info = CallerInfo.from(customParameters: ["callerName": "Jordyn Freedman", "recordId": "00Q000000000001", "recordType": "Lead"], from: "+18585550100")
        XCTAssertEqual(info.displayTitle, "Jordyn Freedman")
        XCTAssertEqual(info.displaySubtitle, "(858) 555-0100 · Lead")
        XCTAssertEqual(info.recordId, "00Q000000000001")
    }
    func testUnmatchedCallerShowsNumberOnly() {
        let info = CallerInfo.from(customParameters: [:], from: "+18585550100")
        XCTAssertEqual(info.displayTitle, "(858) 555-0100")
        XCTAssertNil(info.displaySubtitle)
        XCTAssertNil(info.recordId)
    }
    func testNoFromShowsUnknownCaller() {
        XCTAssertEqual(CallerInfo.from(customParameters: [:], from: nil).displayTitle, "Unknown caller")
    }
    func testSalesforceDeepLink() {
        XCTAssertEqual(salesforceRecordURL("00Q000000000001"), URL(string: "salesforce1://sObject/00Q000000000001/view"))
    }
}
```
```swift
// Tests/CallControllerTests.swift — fakes conform to the protocols; assert transitions.
final class CallControllerTests: XCTestCase {
    @MainActor func testInboundRingAnswerHangupWrapup() async throws {
        let sdk = FakeSDK(); let sys = FakeCallSystem(); let api = FakeCallsAPI()
        let c = CallController(sdk: sdk, system: sys, api: api, tokens: { "voice_t" })
        let invite = FakeInvite(from: "+18585550100", params: ["callerName": "Jordyn Freedman", "recordType": "Lead", "recordId": "00Q1"])
        sdk.nextInvite = invite
        c.handleIncomingPush([:])
        guard case let .ringing(info) = c.phase else { return XCTFail("expected ringing") }
        XCTAssertEqual(sys.reported.last?.title, "Jordyn Freedman · Lead")
        XCTAssertEqual(info.number, "+18585550100")
        c.answer()
        guard case .active = c.phase else { return XCTFail("expected active") }
        XCTAssertTrue(invite.accepted)
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase else { return XCTFail("expected wrapup") }
        XCTAssertNil(callId) // inbound: the server owns the calls row; wrap-up resolves it via pending-disposition
    }
    @MainActor func testOutboundRefusalNeverDials() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI(); api.placeResult = .refused(reason: "Calling FL is Mon-Sat only (today is Sunday, recipient-local)")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "voice_t" })
        await c.placeCall(to: "+18505550100")
        XCTAssertEqual(c.lastRefusal, "Calling FL is Mon-Sat only (today is Sunday, recipient-local)")
        XCTAssertEqual(sdk.connectCalls, 0)
        guard case .idle = c.phase else { return XCTFail("stays idle") }
    }
    @MainActor func testOutboundAllowedConnectsWithCallIdAndWrapsUp() async {
        let sdk = FakeSDK(); let api = FakeCallsAPI(); api.placeResult = .allowed(callId: "c1", fromNumber: "+12135550100")
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: api, tokens: { "voice_t" })
        await c.placeCall(to: "+18585550100")
        XCTAssertEqual(sdk.lastConnectParams?["To"], "+18585550100")
        XCTAssertEqual(sdk.lastConnectParams?["CallDbId"], "c1")
        c.hangUp()
        guard case let .wrapup(callId, _) = c.phase, callId == "c1" else { return XCTFail("wrapup with c1") }
        await c.finishWrapup(disposition: "Left voicemail", notes: "")
        XCTAssertEqual(api.dispositions.last?.callId, "c1")
        guard case .idle = c.phase else { return XCTFail("idle after wrapup") }
    }
    @MainActor func testDeclineRejectsInvite() {
        let sdk = FakeSDK(); let invite = FakeInvite(from: "+1", params: [:]); sdk.nextInvite = invite
        let c = CallController(sdk: sdk, system: FakeCallSystem(), api: FakeCallsAPI(), tokens: { "t" })
        c.handleIncomingPush([:]); c.decline()
        XCTAssertTrue(invite.rejected); guard case .idle = c.phase else { return XCTFail() }
    }
}
```
Define `FakeSDK`, `FakeInvite`, `FakeCall`, `FakeCallSystem`, `FakeCallsAPI` in the test file (each records calls; `FakeCallsAPI` conforms to a `CallsAPIClient` protocol the controller depends on: `place(to:) async throws -> PlaceCallResult`, `disposition(callId:disposition:notes:) async throws`, `pendingDisposition() async throws -> CallSummary?`).

- [ ] **Step 2: Run** → compile failure. **Step 3: Implement** `CallerInfo` (number formatting via the existing `formatE164`-equivalent — check `Shared/Feed.swift`/`StatusView` for an existing formatter; if none, add `formatNANP(_:)` in `CallerInfo.swift` producing `(858) 555-0100`), `salesforceRecordURL(_:)`, and `CallController` exactly per the interface: `handleIncomingPush` calls `sdk.handleIncomingPush` → builds `CallerInfo` → `Task { try await system.reportIncoming(uuid:, title: info.name.map { "\($0) · \(info.recordType ?? "Record")" } ?? info.displayTitle, handle: info.number) }` → `phase = .ringing`. `answer()` → `invite.accept()` → `.active`; `decline()` → `invite.reject()` → `.idle`; `placeCall` → `api.place` → refused sets `lastRefusal` and stays idle; allowed → `sdk.connect(accessToken: tokens(), params: ["To": e164, "CallDbId": callId])` → `.active`; `hangUp` → `.wrapup(callId, info)`; `finishWrapup` → for inbound (`callId == nil`) resolve via `api.pendingDisposition()` then post; `.idle`. The controller owns nothing UIKit/Twilio — only the protocols.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(callsign): call controller state machine over injected voice + CallKit protocols`.

---

### Task 9: Live adapters — Twilio Voice SDK, PushKit, CallKit

**Files:**
- Create: `apps/cti-ios/App/LiveVoiceSDK.swift`, `apps/cti-ios/App/LiveCallSystem.swift`, `apps/cti-ios/App/PushRegistry.swift`, `apps/cti-ios/App/VoiceTokenRefresher.swift`
- Modify: `apps/cti-ios/App/CTIApp.swift` (construct `CallController(sdk: LiveVoiceSDK(), system: LiveCallSystem(), api: LiveCallsAPI(...), tokens: VoiceTokenRefresher.shared.current)`; register PushKit at launch when signed in)
- Create: `apps/cti-ios/Tests/VoiceTokenRefresherTests.swift`
- Modify: `apps/cti-ios/project.yml` (test sources: `App/VoiceTokenRefresher.swift`)

**Interfaces:**
- Produces: `LiveVoiceSDK: VoiceSDK` (wraps `TwilioVoiceSDK.register/unregister/connect/handleNotification`), `LiveCallSystem: CallSystem` (`CXProvider` + `CXCallController`), `PushRegistry` (PKPushRegistry delegate → posts token via `POST /mobile/voip-token` with the device token, and on incoming push calls `controller.handleIncomingPush(payload)` **synchronously before returning from `pushRegistry(_:didReceiveIncomingPushWith:for:completion:)`**), `VoiceTokenRefresher` (pure schedule + fetch; tested).

- [ ] **Step 1: Failing test** for the refresher only (the adapters are untestable host-free):
```swift
final class VoiceTokenRefresherTests: XCTestCase {
    func testRefreshesWhenWithinFiveMinutesOfExpiry() async throws {
        var fetches = 0
        let r = VoiceTokenRefresher(fetch: { fetches += 1; return VoiceToken(token: "t\(fetches)", expiresAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))) }, now: { Date() })
        _ = try await r.current(); _ = try await r.current()
        XCTAssertEqual(fetches, 1) // cached while fresh
        r.forceExpiryForTest(Date().addingTimeInterval(120))
        _ = try await r.current()
        XCTAssertEqual(fetches, 2) // < 5 min left → refreshed
    }
}
```

- [ ] **Step 2: Run** → compile failure. **Step 3: Implement** the refresher (cache token + expiry; refresh when `expiry - now < 300s`; `forceExpiryForTest` under `#if DEBUG`), then the adapters following Twilio's SwiftVoiceQuickstart pattern: `LiveCallSystem` creates `CXProvider(configuration:)` with `supportsVideo = false`, `maximumCallsPerCallGroup = 1`, `supportedHandleTypes = [.phoneNumber]`; `reportIncoming` builds a `CXCallUpdate` with `localizedCallerName = title`, `remoteHandle = CXHandle(type: .phoneNumber, value: handle)`; the provider delegate forwards `CXAnswerCallAction` → `controller.answer()`, `CXEndCallAction` → `controller.hangUp()/decline()`, and routes `didActivate/didDeactivate` audio session to `TwilioVoiceSDK.audioDevice`. `PushRegistry` registers `PKPushRegistry(queue: nil)` with `desiredPushTypes = [.voIP]`, on `didUpdate pushCredentials` stores the token and calls `sdk.register(accessToken:deviceToken:)` + posts it to `/mobile/voip-token` with the device token from `DeviceTokenStore`. In `didReceiveIncomingPush` it MUST call `controller.handleIncomingPush(payload.dictionaryPayload)` (which reports to CallKit synchronously) before `completion()`.

- [ ] **Step 4: Run** unit tests → PASS; build the `Callsign` scheme for the simulator → compiles (link against `TwilioVoice`). **Step 5: Commit** `feat(callsign): live Twilio, PushKit and CallKit adapters`.

---

### Task 10: Screens — Dial, In-call, Wrap-up, Recents, Status

**Files:**
- Create: `apps/cti-ios/App/DialView.swift`, `apps/cti-ios/App/InCallView.swift`, `apps/cti-ios/App/WrapupView.swift`, `apps/cti-ios/App/RecentsView.swift`, `apps/cti-ios/App/MainTabs.swift`
- Modify: `apps/cti-ios/App/StatusView.swift` (signed-in user, numbers count from `/auth/me` if exposed — else omit; sign out = `SessionTokenStore.delete()` + `SyncEngine.unpair()`), `apps/cti-ios/App/CTIApp.swift` (session → `MainTabs`)
- Create: `apps/cti-ios/Tests/DispositionsTests.swift`

**Interfaces:**
- Consumes: `CallController` (Task 8), `CallsAPI` (Task 7), `salesforceRecordURL` (Task 8).
- Produces: `Dispositions.all: [String]` — copied VERBATIM from `apps/cti-web/src/components/WrapupForm.tsx:8` (the array that starts `'Connected', 'Left voicemail', 'No answer', 'Wrong number', …`); a test pins its first four entries and that it has no duplicates.

- [ ] **Step 1: Failing test** (`DispositionsTests`): `XCTAssertEqual(Array(Dispositions.all.prefix(4)), ["Connected", "Left voicemail", "No answer", "Wrong number"])`; `XCTAssertEqual(Set(Dispositions.all).count, Dispositions.all.count)`.

- [ ] **Step 2: Run** → compile failure. **Step 3: Implement** `Dispositions` + the views:
  - `MainTabs`: tabs Dial / Recents / Status; presents `InCallView` full-screen when `controller.phase` is `.dialing/.active`, `WrapupView` as a sheet when `.wrapup`, and an inline refusal banner (`controller.lastRefusal`) on the Dial tab — the exact server text, red, dismissible.
  - `DialView`: keypad (0-9 * #), number field, green call button → `controller.placeCall(to:)`; a "Finish your last call" banner when `pendingDisposition` exists (fetched on appear).
  - `InCallView`: `info.displayTitle` large, `displaySubtitle` muted, timer since `since`, buttons Mute / Speaker (`AVAudioSession.overrideOutputAudioPort`) / Keypad (DTMF via the active call — add `sendDigits(_:)` to `ActiveCall`) / Hang up; **Open in Salesforce** button when `info.recordId != nil` → `UIApplication.shared.open(salesforceRecordURL(id))`.
  - `WrapupView`: `Dispositions.all` picker, notes `TextEditor`, Finish → `controller.finishWrapup`, Skip → `controller.skipWrapup()`.
  - `RecentsView`: `recentCallsRequest(limit: 50)` list — direction glyph, number, disposition, relative time; tap → redial; record present → Open in Salesforce.

- [ ] **Step 4: Run** tests → PASS; build → compiles; run in the iOS Simulator (`mcp__Claude_Code_iOS_Simulator__control` attach/launch) and screenshot each screen — Dial, a refusal banner (dial a number while the API is unreachable to force the error path), Recents, Status. **Step 5: Commit** `feat(callsign): dial, in-call, wrap-up, recents and status screens`.

---

### Task 11: Extension continuity + sign-out + pending-disposition sweep parity

**Files:**
- Modify: `apps/cti-ios/App/SyncEngine.swift` (`unpair()` also deletes the session token via an injected closure; sign-out from Status calls it), `apps/cti-ios/App/StatusView.swift`
- Modify: `apps/cti-ios/Tests/SyncEngineTests.swift`

**Interfaces:**
- Consumes: `SessionTokenStore` (Task 5). Produces: `SyncEngine.TokenStore.deleteSession: () -> Void` (defaults to `SessionTokenStore.delete`).

- [ ] **Step 1: Failing test**: unpair → both `tokens.delete` and `tokens.deleteSession` invoked (extend the existing unpair test's fake TokenStore).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the closure + call it in `unpair()`; Status "Sign out" → `SyncEngine.shared.unpair()` then the root view shows `SignInView`.
- [ ] **Step 4: Run** all tests → PASS. **Step 5: Commit** `feat(callsign): sign-out clears session and directory together`.

---

### Task 12: Release runbook, README, and manual device checklist

**Files:**
- Create: `docs/runbooks/callsign-ios-release.md`
- Modify: `apps/cti-ios/README.md`
- Modify: `services/cti-api/.env.example` (add `TWILIO_IOS_PUSH_CREDENTIAL_SID=`)

- [ ] **Step 1: Write the runbook** with these sections, each as numbered, exact steps: (1) Apple Developer — App IDs `com.gghomes.callsign` (capabilities: Push Notifications, App Groups `group.com.gghomes.cti`) and `com.gghomes.callsign.directory` (App Groups); VoIP Services certificate for `com.gghomes.callsign` → export `.p12`. (2) Twilio Console → Credentials → Push Credentials → new APNs credential (type: **VoIP**, sandbox off for production) → copy the `CR…` SID → Railway `@cti/api` variable `TWILIO_IOS_PUSH_CREDENTIAL_SID` (set via `railway variables --set` — never paste the value in chat/logs) → redeploy. (3) App Store Connect — new app **Callsign**, bundle `com.gghomes.callsign`; provisioning profiles `Callsign AppStore` and `Callsign Directory AppStore` (match `project.yml`); archive + upload; TestFlight internal group first. (4) Distribution — App Store Connect → Pricing and Availability → **Custom App** for the GG Homes Apple Business Manager organization; Mosyle → Apps & Books → license → auto-install to the reps' device group; Managed App Configuration JSON `{"apiBaseUrl":"https://ctiapi-production.up.railway.app"}`. (5) Rep first run — sign in, allow microphone + notifications, enable the Call Directory toggle (Settings path for iOS 17 and 18, as `StatusView` shows). (6) **Manual device checklist** (TestFlight, one phone): inbound ring on a locked phone shows "Name · Lead"; answer → audio both ways; decline → caller reaches voicemail; outbound allowed call connects and shows the rotated caller ID on the far end; outbound refused (dial a Florida lead already at 3/24h, or any number outside hours) shows the server's message and never rings; wrap-up creates the Task with disposition + Chatter + recording link; Open in Salesforce lands on the record; web softphone + iPhone ring together and the first answer wins; token refresh survives an hour idle.
- [ ] **Step 2: README** — rename to Callsign, list the new targets/files, the sign-in flow replacing pairing, the SDK dependency, and point to the runbook.
- [ ] **Step 3: Commit** `docs(callsign): iOS release runbook and README`.

---

## Self-review notes (controller)

- Spec §2.3 said "session-bearer acceptance on caller-directory"; the plan implements the same outcome with `POST /mobile/register` minting the standard device token (Task 3), which keeps the directory, apns-token, and voip-token routes device-token-only and unchanged. Spec updated in spirit; no functional gap.
- Every server route in the spec has a task (1–3); every screen and flow in §3 has a task (5–11); distribution §5 and testing §6 are Task 12 + per-task tests.
- Interface names are declared once in "Shared interfaces" and reused verbatim in Tasks 5–10; `CallsAPIClient` protocol is introduced in Task 8's tests and implemented as `LiveCallsAPI` in Task 9.
- Phase-2 items (power dialer, SMS, in-app records, silent push) are absent by design.
