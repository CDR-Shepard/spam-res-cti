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
  SALESFORCE_LOGIN_URL: z.string().url().default('https://login.salesforce.com').transform((u) => u.replace(/\/+$/, '')),
  SALESFORCE_API_VERSION: z.string().regex(/^v\d+\.\d$/, 'SALESFORCE_API_VERSION must look like v60.0').default('v60.0'),
  /** Claude for note triage (A9); unset = triage disabled. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof schema> & { workosEnabled: boolean; salesforceEnabled: boolean; aiEnabled: boolean };

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
  const salesforceSet = [c.SALESFORCE_CLIENT_ID, c.SALESFORCE_REDIRECT_URI].filter(Boolean).length;
  if (salesforceSet === 1) {
    const missing = c.SALESFORCE_CLIENT_ID ? 'SALESFORCE_REDIRECT_URI' : 'SALESFORCE_CLIENT_ID';
    throw new Error(`Invalid environment configuration:\n  - Salesforce: set SALESFORCE_CLIENT_ID and SALESFORCE_REDIRECT_URI together; missing ${missing}`);
  }
  return { ...c, workosEnabled: set === 3, salesforceEnabled: salesforceSet === 2, aiEnabled: Boolean(c.ANTHROPIC_API_KEY) };
}

let cached: AppConfig | undefined;
export function loadConfig(): AppConfig {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}
