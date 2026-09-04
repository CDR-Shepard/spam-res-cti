import 'dotenv/config';
import { getDb } from '@cti/db';
import { WorkosIdentityProvider } from '../src/auth/workos-provider.js';
import { loadConfig } from '../src/config.js';

/**
 * `--name value` pairs → object; exits (2) with usage when a required flag is
 * missing, a flag has no following value, or a value itself looks like
 * another flag (near-certainly a missing value, e.g. `--name --admin-email x`).
 */
export function flags(required: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    const v = argv[i + 1];
    if (!k) continue;
    if (v === undefined) {
      console.error(`--${k} is missing a value`);
      process.exit(2);
    }
    if (v.startsWith('--')) {
      console.error(`--${k}'s value looks like another flag: ${v}`);
      process.exit(2);
    }
    out[k] = v;
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
