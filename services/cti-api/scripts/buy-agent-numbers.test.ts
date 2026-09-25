/**
 * A small test for buy-agent-numbers.ts (review minor: newly-bought numbers
 * must also get SmsUrl/SmsMethod set, using the same URL builder as
 * set-sms-webhooks.mjs, or they'd sit uncovered until someone remembers to
 * re-run that script). The rest of this script connects to real Twilio/
 * Postgres and is gated behind an `isMain` check (see the module's bottom)
 * — importing it for `purchaseFields` never touches either.
 */
import { describe, expect, it } from 'vitest';
import { purchaseFields } from './buy-agent-numbers.js';

describe('purchaseFields — the Twilio purchase request body', () => {
  it('sets VoiceUrl/VoiceMethod AND SmsUrl/SmsMethod=POST, plus PhoneNumber/FriendlyName, and nothing else', () => {
    expect(
      purchaseFields(
        '+16195550100',
        'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
        'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
        'Agent evren LA',
      ),
    ).toEqual({
      PhoneNumber: '+16195550100',
      VoiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      VoiceMethod: 'POST',
      SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
      SmsMethod: 'POST',
      FriendlyName: 'Agent evren LA',
    });
  });
});
