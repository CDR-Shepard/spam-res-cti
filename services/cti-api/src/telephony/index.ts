import { loadConfig } from '../config.js';
import type { TelephonyProvider } from './types.js';
import { TwilioProvider } from './twilio.js';

let cached: TelephonyProvider | undefined;

export function getProvider(): TelephonyProvider {
  if (cached) return cached;
  const cfg = loadConfig();
  switch (cfg.TELEPHONY_PROVIDER) {
    case 'twilio':
      cached = new TwilioProvider();
      return cached;
    case 'telnyx':
      throw new Error('Telnyx provider not yet implemented in MVP — see services/cti-api/src/telephony/types.ts');
    default:
      throw new Error(`Unknown TELEPHONY_PROVIDER: ${cfg.TELEPHONY_PROVIDER}`);
  }
}

export * from './types.js';
