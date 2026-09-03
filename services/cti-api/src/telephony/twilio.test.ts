import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_KEY_SID: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_KEY_SECRET: 'secretsecretsecretsecretsecret12',
    TWILIO_TWIML_APP_SID: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_IOS_PUSH_CREDENTIAL_SID: 'CRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  }),
}));

import { TwilioProvider } from './twilio.js';

function voiceGrant(token: string): Record<string, unknown> {
  const decoded = jwt.decode(token) as { grants: { voice: Record<string, unknown> } };
  return decoded.grants.voice;
}

describe('createClientToken platform branch', () => {
  it('web tokens carry no push credential', async () => {
    const res = await new TwilioProvider().createClientToken({ userId: 'u1', identity: 'rep_u1' });
    expect(voiceGrant(res.token).push_credential_sid).toBeUndefined();
  });
  it('ios tokens carry the VoIP push credential', async () => {
    const res = await new TwilioProvider().createClientToken({ userId: 'u1', identity: 'rep_u1', platform: 'ios' });
    expect(voiceGrant(res.token).push_credential_sid).toBe('CRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(voiceGrant(res.token).incoming).toEqual({ allow: true });
  });
});
