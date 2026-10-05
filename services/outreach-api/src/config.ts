import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4100),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4100'),
  /** Origin the browser app lives on; sign-in redirects land at `${APP_PUBLIC_URL}/auth/callback`. */
  APP_PUBLIC_URL: z.string().url().default('http://localhost:5175'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  DATABASE_URL: z.string().url(),
  WORKOS_API_KEY: z.string().min(1).optional(),
  WORKOS_CLIENT_ID: z.string().min(1).optional(),
  WORKOS_REDIRECT_URI: z.string().url().optional(),
  PGBOSS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('pgboss'),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  /** Salesforce Connected App for the company-wide Integration-user connection (Settings → Connections). */
  SALESFORCE_CLIENT_ID: z.string().min(1).optional(),
  /** Optional with PKCE; sent when the Connected App has "Require Secret for Web Server Flow" on. */
  SALESFORCE_CLIENT_SECRET: z.string().min(1).optional(),
  /** `${API_PUBLIC_URL}/api/connections/salesforce/callback` — must match the Connected App's callback URL exactly. */
  SALESFORCE_REDIRECT_URI: z.string().url().optional(),
  /** `${API_PUBLIC_URL}/api/auth/salesforce/callback` — people sign in to outreach-web with Salesforce (same External Client App as the CTI). */
  SALESFORCE_SIGNIN_REDIRECT_URI: z.string().url().optional(),
  /** When set, only this Salesforce org may sign in (first 15 characters compared), as in cti-api. */
  SALESFORCE_ALLOWED_ORG_ID: z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/, 'SALESFORCE_ALLOWED_ORG_ID must be a 15- or 18-character org Id').optional(),
  SALESFORCE_LOGIN_URL: z.string().url().default('https://login.salesforce.com').transform((u) => u.replace(/\/+$/, '')),
  SALESFORCE_API_VERSION: z.string().regex(/^v\d+\.\d$/, 'SALESFORCE_API_VERSION must look like v60.0').default('v60.0'),
  /** Claude for note triage (A9); unset = triage disabled. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Claude model for AI call plans (plan 1C). Must be priced in ai/model.ts PRICE_MICROS_PER_TOKEN. */
  CALL_PLAN_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  /** cti-api on Railway's private network, e.g. http://ctiapi.railway.internal:4000 (plan 1C). */
  CTI_INTERNAL_URL: z.string().url().optional(),
  /** Shared with cti-api: HMAC key for the internal AI call trigger. */
  OUTREACH_INTERNAL_SECRET: z.string().min(32).optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  workosEnabled: boolean;
  salesforceEnabled: boolean;
  salesforceSignInEnabled: boolean;
  aiEnabled: boolean;
  /** The internal AI call trigger is configured: CTI_INTERNAL_URL and OUTREACH_INTERNAL_SECRET are both set. */
  aiCallsEnabled: boolean;
};

/** Pure: parses a raw env map. Empty strings count as unset (deploy UIs write them). */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const source: Record<string, string | undefined> = { ...env, API_PORT: env.API_PORT ?? env.PORT };
  for (const key of Object.keys(source)) if (source[key] === '') delete source[key];
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const workosVars = [c.WORKOS_API_KEY, c.WORKOS_CLIENT_ID, c.WORKOS_REDIRECT_URI];
  const set = workosVars.filter(Boolean).length;
  if (set !== 0 && set !== 3) {
    const missing = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI'].filter((k) => !(c as Record<string, unknown>)[k]);
    throw new Error(`Invalid environment configuration:\n  - WorkOS: set all three or none; missing ${missing.join(', ')}`);
  }
  const redirects = [c.SALESFORCE_REDIRECT_URI, c.SALESFORCE_SIGNIN_REDIRECT_URI].filter(Boolean).length;
  if (redirects > 0 && !c.SALESFORCE_CLIENT_ID) {
    throw new Error('Invalid environment configuration:\n  - Salesforce: a redirect uri is set but SALESFORCE_CLIENT_ID is missing');
  }
  if (c.SALESFORCE_CLIENT_ID && redirects === 0) {
    throw new Error('Invalid environment configuration:\n  - Salesforce: SALESFORCE_CLIENT_ID needs SALESFORCE_REDIRECT_URI (integration connection) and/or SALESFORCE_SIGNIN_REDIRECT_URI (sign-in)');
  }
  return {
    ...c,
    workosEnabled: set === 3,
    salesforceEnabled: Boolean(c.SALESFORCE_CLIENT_ID && c.SALESFORCE_REDIRECT_URI),
    salesforceSignInEnabled: Boolean(c.SALESFORCE_CLIENT_ID && c.SALESFORCE_SIGNIN_REDIRECT_URI),
    aiEnabled: Boolean(c.ANTHROPIC_API_KEY),
    aiCallsEnabled: Boolean(c.CTI_INTERNAL_URL && c.OUTREACH_INTERNAL_SECRET),
  };
}

let cached: AppConfig | undefined;
export function loadConfig(): AppConfig {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}
