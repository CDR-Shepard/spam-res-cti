import 'dotenv/config';
import { getDb } from '@cti/db';
import { WorkosIdentityProvider } from '../src/auth/workos-provider.js';
import { loadConfig } from '../src/config.js';

/** `--name value` pairs → object; exits with usage when a required flag is missing. */
export function flags(required: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    const v = argv[i + 1];
    if (k && v !== undefined) out[k] = v;
  }
  const missing = required.filter((r) => !out[r]);
  if (missing.length) {
    console.error(`missing flags: ${missing.map((m) => `--${m}`).join(' ')}`);
    process.exit(2);
  }
  return out;
}

export function deps() {
  const cfg = loadConfig();
  if (!cfg.workosEnabled) throw new Error('WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_REDIRECT_URI must be set');
  const idp = new WorkosIdentityProvider({ apiKey: cfg.WORKOS_API_KEY!, clientId: cfg.WORKOS_CLIENT_ID!, redirectUri: cfg.WORKOS_REDIRECT_URI! });
  return { db: getDb(), idp, log: console };
}
