import { z } from 'zod';

/** A Salesforce User id (key prefix 005), 15 or 18 characters: the same shape the booking settings contract accepts. */
const SF_USER_ID = /^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const SPECIALISTS_MESSAGE = 'AI_CALL_DEFAULT_SPECIALISTS must be comma-separated Salesforce User ids (15 or 18 characters starting 005)';
/** A dotted DNS hostname (`reply.example.com`): no scheme, path, port, address or space. The reply mailboxes live under it, so a bare `localhost` cannot work. */
const REPLY_DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

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
  /**
   * Plan 1D: Claude model that maps a call's answers to the org's picklist values for the Salesforce write-back. An
   * unpriced model (ai/model.ts PRICE_MICROS_PER_TOKEN) is refused: fill-blanks are then skipped and noted.
   */
  // Claude 4: the Lead mapping schema is "too complex" for a Claude 5 structured output, and Claude 5 refuses a forced tool.
  WRITEBACK_MODEL: z.string().min(1).default('claude-haiku-4-5-20251001'),
  /** Resend (Sam's email channel): the send/read API key. Both Resend variables or neither; see parseConfig. */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Resend's Svix signing secret for the inbound webhook: `whsec_` + base64. The message never echoes the value. */
  RESEND_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/=]+$/, 'RESEND_WEBHOOK_SECRET must be Resend\'s signing secret: whsec_ followed by base64').optional(),
  /** The From header of every email Sam sends: a display name and an address on the verified Resend domain. */
  EMAIL_FROM: z.string().min(1).default('Sam at GG Homes <sam@rethinkre.team>'),
  /** Where replies land: `sam+<token>@<this>` (email/addresses.ts). Its MX points at Resend's inbound. */
  EMAIL_REPLY_DOMAIN: z.string().regex(REPLY_DOMAIN, 'EMAIL_REPLY_DOMAIN must be a hostname such as reply.example.com (no scheme, path or address)').default('reply.rethinkre.team'),
  /** The sender's physical postal address, printed in every email footer (CAN-SPAM). */
  EMAIL_POSTAL_ADDRESS: z.string().min(1).default('18872 MacArthur Blvd #220, Irvine, CA 92612'),
  /** The company named in the email footer. */
  EMAIL_COMPANY_NAME: z.string().min(1).default('GG Homes'),
  /** Claude model that drafts Sam's emails. Must be priced in ai/model.ts PRICE_MICROS_PER_TOKEN: the email worker refuses an unpriced one. */
  EMAIL_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  /** cti-api on Railway's private network, e.g. http://ctiapi.railway.internal:4000 (plan 1C). */
  CTI_INTERNAL_URL: z
    .string()
    .url()
    .refine(isHttp, 'CTI_INTERNAL_URL must use http: or https:')
    .refine(isOrigin, 'CTI_INTERNAL_URL must be an origin only (scheme, host and port): no path, query, fragment or credentials')
    .optional(),
  /** Shared with cti-api: HMAC key for the internal AI call trigger. */
  OUTREACH_INTERNAL_SECRET: z.string().min(32).optional(),
  /** Google Maps (Geocoding + Routes) for Sam's booking: property county and rep drive times. Unset = no maps; booking offers no times. */
  GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  /**
   * Plan 1D: the default appointment owner list, comma-separated Salesforce User ids (005…), in order. Used until a tenant
   * saves its own list in the AI calls settings card. Production: Grant Golden. Empty (the default) = nobody to book with.
   */
  AI_CALL_DEFAULT_SPECIALISTS: z
    .string()
    .default('')
    .transform((v) => [...new Set(v.split(',').map((id) => id.trim()).filter((id) => id !== ''))])
    .pipe(z.array(z.string().regex(SF_USER_ID, SPECIALISTS_MESSAGE)).max(20, 'AI_CALL_DEFAULT_SPECIALISTS takes at most 20 ids')),
});

/** Only http and https are fetched; `ftp://`, `file://` and `javascript:` all parse as URLs. */
function isHttp(value: string): boolean {
  if (!URL.canParse(value)) return true; // .url() already reports it
  const { protocol } = new URL(value);
  return protocol === 'http:' || protocol === 'https:';
}

/** `http://host:port` and nothing after it (a lone trailing slash is fine): the client appends the signed paths itself. */
function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return true; // .url() already reports it
  const u = new URL(value);
  return (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === '' && u.username === '' && u.password === '';
}

export type AppConfig = z.infer<typeof schema> & {
  workosEnabled: boolean;
  salesforceEnabled: boolean;
  salesforceSignInEnabled: boolean;
  aiEnabled: boolean;
  /** The internal AI call trigger is configured: CTI_INTERNAL_URL and OUTREACH_INTERNAL_SECRET are both set. */
  aiCallsEnabled: boolean;
  /** The email channel is configured: RESEND_API_KEY and RESEND_WEBHOOK_SECRET are both set. */
  emailEnabled: boolean;
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
  const resendVars = { RESEND_API_KEY: c.RESEND_API_KEY, RESEND_WEBHOOK_SECRET: c.RESEND_WEBHOOK_SECRET };
  const resendMissing = Object.entries(resendVars).filter(([, v]) => !v).map(([k]) => k);
  if (resendMissing.length === 1) {
    throw new Error(`Invalid environment configuration:\n  - Resend: set both RESEND_API_KEY and RESEND_WEBHOOK_SECRET or neither; missing ${resendMissing[0]}`);
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
    emailEnabled: resendMissing.length === 0,
  };
}

let cached: AppConfig | undefined;
export function loadConfig(): AppConfig {
  if (!cached) cached = parseConfig(process.env);
  return cached;
}
