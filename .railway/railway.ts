import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const spamResCti = github("CDR-Shepard/spam-res-cti", { checkSuites: false });

  const Postgres = postgres("Postgres", { region: "us-west2" });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 50000 });
  const _ctidesktop = service("@cti/desktop", {
    source: spamResCti,
    build: { buildCommand: "npm run build --workspace=@cti/desktop", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["/apps/cti-desktop/**"] },
    start: "npm run start --workspace=@cti/desktop",
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "ctidesktop" },
  });
  // Pulled live state, not authored here. The "npm run dev" start command
  // (rather than a production server) is pre-existing and out of scope for
  // this work — do not change it as part of the outreach-api IaC task.
  const _ctiweb = service("@cti/web", {
    source: spamResCti,
    build: { buildCommand: "npm run build --workspace=@cti/web", buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["/apps/cti-web/**"] },
    start: "npm run dev --workspace=@cti/web",
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "ctiweb" },
  });
  const _ctiapi = service("@cti/api", {
    source: spamResCti,
    build: "npm run build --workspace=@cti/api",
    start: "npm run start --workspace=@cti/api",
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "ctiapi" },
    env: { AI_SUMMARY_MODEL: preserve(), AI_VOICE: preserve(), AI_VOICE_AGENT_NAME: preserve(), AI_VOICE_MAX_CALL_SECONDS: preserve(), AI_VOICE_MODEL: preserve(), AI_VOICE_REASONING: preserve(), AI_VOICE_TEST_NUMBERS: preserve(), AI_VOICE_VAD_EAGERNESS: preserve(), AI_VOICE_VOICE: preserve(), ALERT_WEBHOOK_URL: preserve(), ANTHROPIC_API_KEY: preserve(), API_PORT: preserve(), API_PUBLIC_URL: preserve(), CTI_API_BASE_URL: preserve(), DATABASE_URL: preserve(), DIALER_CALLING_HOURS_EXEMPT: preserve(), HANDOFF_SHARED_SECRET: preserve(), NODE_ENV: preserve(), NUMBERVERIFIER_API_BASE: preserve(), NUMBERVERIFIER_VERIFY_KEY: preserve(), OPENAI_API_KEY: preserve(), OUTREACH_INTERNAL_SECRET: preserve(), OUTREACH_KILL_SWITCH: preserve(), PORT: preserve(), REPUTATION_WORKER_INTERVAL_MS: preserve(), SALESFORCE_ALLOWED_ORG_ID: preserve(), SALESFORCE_API_VERSION: preserve(), SALESFORCE_CLIENT_ID: preserve(), SALESFORCE_LOGIN_URL: preserve(), SALESFORCE_REDIRECT_URI: preserve(), SESSION_SECRET: preserve(), TELEPHONY_PROVIDER: preserve(), TOKEN_ENCRYPTION_KEY: preserve(), TWILIO_ACCOUNT_SID: preserve(), TWILIO_API_KEY_SECRET: preserve(), TWILIO_API_KEY_SID: preserve(), TWILIO_AUTH_TOKEN: preserve(), TWILIO_DEFAULT_CALLER_ID: preserve(), TWILIO_IOS_PUSH_CREDENTIAL_SID: preserve(), TWILIO_SKIP_SIGNATURE_CHECK: preserve(), TWILIO_TWIML_APP_SID: preserve(), VITE_API_BASE_URL: preserve() },
  });

  // Second product service (outreach-api). This block is authored by hand, not
  // pulled, and is a RECORD of the live service, not a way to create it: the service
  // was created with the CLI, and `railway config apply` must not be run for it.
  // Railway applies the repo's root railway.json (and so the root Dockerfile, which
  // now also builds outreach-web and outreach-api) to every service built from this
  // repo and refuses per-service config files. So outreach-api's start command
  // (node services/outreach-api/dist/server.js) and PORT 4100 are set in the
  // dashboard, and its pre-deploy step is the root railway.json's migrate.
  // See docs/runbooks/outreach-sf-campaigns.md "How outreach-api is deployed".
  const outreachApi = service("outreach-api", {
    source: github("CDR-Shepard/spam-res-cti", { branch: "main", checkSuites: false }),
    preDeploy: "npm --workspace packages/db run migrate",
    start: "node services/outreach-api/dist/server.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    env: {
      NODE_ENV: "production",
      RAILWAY_DOCKERFILE_PATH: "services/outreach-api/Dockerfile",
      DATABASE_URL: Postgres.env.DATABASE_URL,
      // Same values as the CTI API so sessions and encrypted tokens interoperate.
      // preserve()'d (not referenced from _ctiapi) to match the runbook, which has
      // the operator copy these by hand in the dashboard after the first apply.
      TOKEN_ENCRYPTION_KEY: preserve(),
      SESSION_SECRET: preserve(),
      // Filled in the dashboard after the first apply (see the runbook).
      API_PUBLIC_URL: preserve(),
      APP_PUBLIC_URL: preserve(),
      WORKOS_API_KEY: preserve(),
      WORKOS_CLIENT_ID: preserve(),
      WORKOS_REDIRECT_URI: preserve(),
      // Optional: PORT (4100) and the Salesforce API version are held in the dashboard.
      PORT: preserve(),
      SALESFORCE_API_VERSION: preserve(),
      // Salesforce External Client App (Caller_Reputation_CTI) for the integration
      // connection, Claude for triage and call plans, and the private-network link to
      // @cti/api for AI calls (plan 1C). All filled in the dashboard; see
      // docs/runbooks/outreach-sf-campaigns.md. SALESFORCE_CLIENT_SECRET is not used:
      // the app is PKCE-only with no secret.
      SALESFORCE_REDIRECT_URI: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      CALL_PLAN_MODEL: preserve(),
      // http://ctiapi.railway.internal:4000 (@cti/api's private domain and API_PORT). An origin only.
      CTI_INTERNAL_URL: preserve(),
      // The same value as on @cti/api.
      OUTREACH_INTERNAL_SECRET: preserve(),
      // Sign in with Salesforce (plan 1C Part 0): the CTI's External Client App
      // Caller_Reputation_CTI (PKCE, no secret). Filled in the dashboard.
      SALESFORCE_CLIENT_ID: preserve(),
      SALESFORCE_LOGIN_URL: preserve(),
      SALESFORCE_SIGNIN_REDIRECT_URI: preserve(),
      SALESFORCE_ALLOWED_ORG_ID: preserve(),
      PGBOSS_SCHEMA: "pgboss",
    },
  });

  return project("endearing-comfort", {
    resources: [_ctidesktop, Postgres, _ctiweb, _ctiapi, postgresVolume, outreachApi],
  });
});
