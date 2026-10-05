# Outreach Salesforce campaigns — operator runbook

Everything here is a human step. The code ships with plan 1B (`docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md`); the design is `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md`.

The target org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes the stale `layouts/` snapshots over the org's live layouts.

## Signing in to Outreach

People sign in to outreach-web with Salesforce, the same login as the CTI softphone. It uses the CTI's External Client App `Caller_Reputation_CTI` (PKCE, no client secret).

**Who can sign in.** Only people who already exist in the CTI, in a tenant the CTI already has for their Salesforce org. Outreach never creates a tenant or a user from a sign-in, and never changes admin rights. Signing in to the CTI softphone once is enough to create a person. Admin rights are the CTI's (set from the Salesforce profile when someone signs in to the CTI). The Salesforce token a sign-in obtains is revoked and dropped straight away: nothing is stored.

**The variables on outreach-api** (Railway, filled in the dashboard):

| Variable | Value |
|---|---|
| `SALESFORCE_CLIENT_ID` | The `Caller_Reputation_CTI` consumer key, the same as `@cti/api`'s |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` |
| `SALESFORCE_SIGNIN_REDIRECT_URI` | `https://outreach-api-production-a07b.up.railway.app/api/auth/salesforce/callback` (already on the app's callback list) |
| `SALESFORCE_ALLOWED_ORG_ID` | Optional. Copy `@cti/api`'s, so only that org can sign in |

There is no client secret: the app requires PKCE. Redeploy outreach-api after changing them. Sign-in is on when `SALESFORCE_CLIENT_ID` and `SALESFORCE_SIGNIN_REDIRECT_URI` are both set.

**Error words.** A failed sign-in lands on `/sign-in?error=<reason>`:

| Reason | What it means, and the fix |
|---|---|
| `no_account` | The Salesforce org is known but this person is not in the CTI. Have them sign in to the CTI softphone once, or ask an admin to add them. |
| `no_tenant` | No CTI tenant has this Salesforce org. The CTI creates the tenant on its first Salesforce login. |
| `tenant_suspended` | The tenant is suspended. |
| `org_not_allowed` | `SALESFORCE_ALLOWED_ORG_ID` is set and this is another org. Sign in with the right org, or correct the variable. |
| `salesforce_unavailable` | Salesforce did not answer (or answered inconsistently). Try again in a minute. |
| `invalid_code` | The Salesforce code was refused (expired or already used). Start again. |
| `bad_state` | The attempt expired, or was started in another tab or browser. Start again. |
| `bad_return_to` | The link's return address was unsafe and was dropped. Sign in as usual. |
| `access_denied` / `missing_code` | The person cancelled in Salesforce, or Salesforce sent no code. |
| `forbidden` | The account cannot hold a session (a service user). |
| `sign_in_disabled` | Salesforce sign-in is not configured on outreach-api (see the variables above). |
| `server_error` | Something failed in outreach-api. Check its logs (the error name is logged, never the code or a token). |

**WorkOS is optional.** With `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` and `WORKOS_REDIRECT_URI` all set, the sign-in page also offers "Sign in with email". Leave them unset and the button is hidden.

**The integration connection is separate.** Settings → Connections (§0.5 below, `SALESFORCE_REDIRECT_URI`) signs in the Integration user through a different callback on the same app. Confirm `/api/connections/salesforce/callback` is on the app's callback list as well as `/api/auth/salesforce/callback`.

## 0. Salesforce setup (one time, ~30 minutes)

outreach-api connects to Salesforce as one company-wide **Integration user**, never as a rep. That user gets exactly the access in the `AI_Outreach` permission set, plus an in-org permission set for the tenant's own custom fields.

1. **Create the Integration user.** Setup → Users → New User:
   - **User License:** `Salesforce Integration`. **Profile:** `Minimum Access - API Only Integrations`.
   - Name it so it reads well on records it touches, for example `AI Outreach`. Use a real mailbox you control for the email.
   - Save, then on the user's page → **Permission Set License Assignments** → **Edit Assignments** → tick `Salesforce API Integration` → Save.

   > **Risk to check before step 5:** an API-only user cannot sign in to the Salesforce web UI, and the Connections page (§0.5) signs in through the browser (OAuth web-server flow with PKCE). If the browser sign-in is refused for this user, use a dedicated full-license user named `AI Outreach` with the same permission sets instead, and raise it with the outreach-api owners. A client-credentials connection for the Integration user is a planned follow-up, not built yet.

2. **Validate, then deploy the consent fields and the `AI_Outreach` permission set.** From the repo root on `main`, in `salesforce/`. Name the seven files explicitly:

   ```bash
   cd salesforce
   SRC=(
     force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
   )
   sf project deploy validate -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded`. If it is refused:
   - `Field … is not permissionable` (or a similar FLS error) on a standard field: delete that one `<fieldPermissions>` block from `AI_Outreach.permissionset-meta.xml`, then run `npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts`. Update the test's expected list to match, commit both, and validate again.
   - Anything about `layouts`: you passed a directory. Pass only the seven files above.

   Then deploy the same seven files:

   ```bash
   sf project deploy start -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded` and seven `Created` rows. Reruns show `Unchanged`.

3. **Assign `AI_Outreach` to the Integration user.**

   ```bash
   sf org assign permset -n AI_Outreach -o _t2 -b <integration username>
   ```

   If the assignment is refused because **Edit Tasks** is not allowed by the user's license, remove the `<userPermissions>` block (`EditTask`) and the `Activity.CTI_Origin__c` `<fieldPermissions>` block, and update the metadata test to match. Then redeploy (step 2) and retry the assignment. Phase 1 writes no Tasks; restore both blocks before phase 2 starts writing them.

4. **Grant the tenant's own fields in the org.** These fields exist only in this org, so they cannot live in the repo permission set: a reference to a missing field fails the whole deploy. Setup → Permission Sets → New: Label `AI Outreach Fields`, API name `AI_Outreach_Fields`, no license. Under **Object Settings**, grant **Read** on:
   - **Lead:** Address (State), `Notes__c`, `Agent_Notes__c`, `Motivation__c`, `SecondaryMotivation__c`, `Appointment_Notes__c`, `Analyst_Notes__c`, `Lead_Form_Source__c`, `LeadManager__c`.
   - **Opportunity:** `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`, `Lead_Form_Source__c`, `LeadManager__c`, and whichever notes fields the tenant's Opportunity field map reads.
   - **Task:** Description.

   Grant only the fields this tenant's field map uses (Settings → Connections → field map). Assign the set to the Integration user. Skip any field the org doesn't have.

5. **Connected app** (Setup → App Manager → New Connected App, or New External Client App):
   - Callback URL: `${API_PUBLIC_URL}/api/connections/salesforce/callback`, using outreach-api's public URL from `outreach-api-deploy.md` §2.
   - OAuth scopes: `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - Require **PKCE**. Refresh token policy: **valid until revoked**. Under **Manage → Edit Policies**, set Permitted Users to "Admin approved users are pre-authorized" and add the `AI Outreach` permission set, so only the Integration user can use the app.
   - Set the outreach-api Railway variables `SALESFORCE_CLIENT_ID` (consumer key), `SALESFORCE_CLIENT_SECRET` (consumer secret; outreach-api sends it when it is set), and `SALESFORCE_REDIRECT_URI` (the callback URL above). Then redeploy outreach-api.
   - In outreach-web, open **Settings → Connections** as an admin, choose **Connect Salesforce**, and sign in **as the Integration user**. The page should show it as connected with the Integration user's username.

6. **Optional, in Setup only:** to let reps see the consent fields, add them to the Lead and Opportunity page layouts through the Setup UI. **Do not** deploy layouts from the repo (`salesforce/README.md`). If reps should record consent themselves (source `Rep`), give their profile or permission set **edit** on the three fields.

**Check:** on any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date`, and `AI Call Consent Source` with five values in order: Text Reply, Email Reply, Web Form, Inbound Call, Rep.
