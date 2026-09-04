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
    env: { ALERT_WEBHOOK_URL: preserve(), API_PORT: preserve(), API_PUBLIC_URL: preserve(), CTI_API_BASE_URL: preserve(), DATABASE_URL: preserve(), DIALER_CALLING_HOURS_EXEMPT: preserve(), HANDOFF_SHARED_SECRET: preserve(), NODE_ENV: preserve(), NUMBERVERIFIER_API_BASE: preserve(), NUMBERVERIFIER_VERIFY_KEY: preserve(), PORT: preserve(), REPUTATION_WORKER_INTERVAL_MS: preserve(), SALESFORCE_ALLOWED_ORG_ID: preserve(), SALESFORCE_API_VERSION: preserve(), SALESFORCE_CLIENT_ID: preserve(), SALESFORCE_LOGIN_URL: preserve(), SALESFORCE_REDIRECT_URI: preserve(), SESSION_SECRET: preserve(), TELEPHONY_PROVIDER: preserve(), TOKEN_ENCRYPTION_KEY: preserve(), TWILIO_ACCOUNT_SID: preserve(), TWILIO_API_KEY_SECRET: preserve(), TWILIO_API_KEY_SID: preserve(), TWILIO_AUTH_TOKEN: preserve(), TWILIO_DEFAULT_CALLER_ID: preserve(), TWILIO_SKIP_SIGNATURE_CHECK: preserve(), TWILIO_TWIML_APP_SID: preserve(), VITE_API_BASE_URL: preserve() },
  });

  // Second product service (outreach-api). Newly created here — not yet live —
  // so this block, unlike the ones above, is authored by hand rather than
  // pulled. It builds from the same monorepo via Docker (RAILWAY_DOCKERFILE_PATH)
  // instead of Railpack + npm workspace scripts like the CTI services.
  const outreachApi = service("outreach-api", {
    source: github("CDR-Shepard/spam-res-cti", { branch: "main" }),
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
      PGBOSS_SCHEMA: "pgboss",
    },
  });

  return project("endearing-comfort", {
    resources: [_ctidesktop, Postgres, _ctiweb, _ctiapi, postgresVolume, outreachApi],
  });
});
