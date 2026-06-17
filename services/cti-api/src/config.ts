import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),

  DATABASE_URL: z.string().url(),

  SALESFORCE_CLIENT_ID: z.string().min(1).optional(),
  SALESFORCE_CLIENT_SECRET: z.string().min(1).optional(),
  SALESFORCE_REDIRECT_URI: z.string().url().optional(),
  SALESFORCE_LOGIN_URL: z.string().url().default('https://login.salesforce.com'),
  SALESFORCE_API_VERSION: z.string().default('v60.0'),
  /**
   * Salesforce org id (15- or 18-char) allowed to "Sign in with Salesforce".
   * When set, only users from THIS org can log in — prevents anyone with any
   * Salesforce account from self-provisioning into your CTI. Strongly
   * recommended in production; when unset, any SF org can sign in.
   */
  SALESFORCE_ALLOWED_ORG_ID: z.string().min(15).optional(),
  /**
   * Comma-separated emails granted admin (manage numbers/assignment/campaigns)
   * on Salesforce login, in addition to the first user provisioned for an org.
   */
  ADMIN_EMAILS: z.string().optional(),

  TELEPHONY_PROVIDER: z.enum(['twilio', 'telnyx']).default('twilio'),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  TWILIO_DEFAULT_CALLER_ID: z.string().optional(),
  /**
   * Local-dev-only escape hatch to skip Twilio webhook signature validation
   * (e.g. when replaying captured webhooks). Never set this in a deployed
   * environment — signatures are otherwise always enforced regardless of
   * NODE_ENV. Defaults to false.
   */
  TWILIO_SKIP_SIGNATURE_CHECK: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  TELNYX_API_KEY: z.string().optional(),
  TELNYX_CONNECTION_ID: z.string().optional(),
  TELNYX_DEFAULT_CALLER_ID: z.string().optional(),

  /** Optional Slack-compatible webhook for reputation/attestation alerts. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  /**
   * NumberVerifier (app.numberverifier.com) caller-ID reputation integration.
   * Shared secret echoed in the inbound webhook's `x-verifykey` header — set the
   * SAME value here and in the NumberVerifier dashboard's Webhooks page. When
   * unset, the /integrations/numberverifier/webhook route is disabled (503).
   * The API key/base are for the future on-demand pull API (destination RND).
   */
  NUMBERVERIFIER_VERIFY_KEY: z.string().min(1).optional(),
  NUMBERVERIFIER_API_KEY: z.string().optional(),
  NUMBERVERIFIER_API_BASE: z.string().url().default('https://app.numberverifier.com'),
  /** How often the reputation worker recomputes per-DID health (ms). */
  REPUTATION_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * Comma-separated allowlist of browser origins permitted to call the API in
   * production (the served cti-web origin + your Salesforce my-domain). The
   * Electron desktop uses a non-browser origin and is always allowed. Leave
   * unset only in development, where all origins are reflected.
   */
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  // Most hosts (Railway, Render, Fly, Heroku) inject the listen port as PORT.
  // Honor it while keeping API_PORT for local dev / explicit overrides.
  const source: Record<string, string | undefined> = {
    ...process.env,
    API_PORT: process.env.API_PORT ?? process.env.PORT,
  };
  // Treat empty-string env vars as unset. Deploy UIs (e.g. Railway's
  // "add suggested variables") populate optional fields with "", which would
  // otherwise fail validation on URL-typed optionals like ALERT_WEBHOOK_URL.
  for (const key of Object.keys(source)) {
    if (source[key] === '') delete source[key];
  }
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
