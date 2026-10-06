import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from './config.js';

const base = {
  TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  SESSION_SECRET: 's'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};

afterEach(() => vi.unstubAllEnvs());

describe('parseConfig', () => {
  it('applies defaults and honors PORT as the listen port', () => {
    const cfg = parseConfig({ ...base, PORT: '8080' });
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.APP_PUBLIC_URL).toBe('http://localhost:5175');
    expect(cfg.PGBOSS_SCHEMA).toBe('pgboss');
    expect(cfg.workosEnabled).toBe(false);
  });
  it('treats empty strings as unset', () => {
    const cfg = parseConfig({ ...base, ALERT_WEBHOOK_URL: '', WORKOS_API_KEY: '' });
    expect(cfg.ALERT_WEBHOOK_URL).toBeUndefined();
  });
  it('enables WorkOS only when all three variables are present', () => {
    const cfg = parseConfig({ ...base, WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_1', WORKOS_REDIRECT_URI: 'http://localhost:4100/api/auth/workos/callback' });
    expect(cfg.workosEnabled).toBe(true);
    expect(() => parseConfig({ ...base, WORKOS_API_KEY: 'sk_test' })).toThrow(/WORKOS_CLIENT_ID/);
  });
  it('enables Salesforce only when the client id and redirect uri are both set; one without the other throws', () => {
    expect(parseConfig(base).salesforceEnabled).toBe(false);
    const cfg = parseConfig({ ...base, SALESFORCE_CLIENT_ID: '3MVG9-client', SALESFORCE_REDIRECT_URI: 'http://localhost:4100/api/connections/salesforce/callback' });
    expect(cfg.salesforceEnabled).toBe(true);
    expect(cfg.SALESFORCE_CLIENT_SECRET).toBeUndefined();
    expect(() => parseConfig({ ...base, SALESFORCE_CLIENT_ID: '3MVG9-client' })).toThrow(/SALESFORCE_REDIRECT_URI/);
    expect(() => parseConfig({ ...base, SALESFORCE_REDIRECT_URI: 'http://localhost:4100/api/connections/salesforce/callback' })).toThrow(/SALESFORCE_CLIENT_ID/);
  });
  describe('Salesforce sign-in', () => {
    const signIn = 'http://localhost:4100/api/auth/salesforce/callback';
    it('is enabled by the client id and the sign-in redirect alone, leaving the integration connection off', () => {
      const cfg = parseConfig({ ...base, SALESFORCE_CLIENT_ID: '3MVG9-client', SALESFORCE_SIGNIN_REDIRECT_URI: signIn });
      expect(cfg.salesforceSignInEnabled).toBe(true);
      expect(cfg.salesforceEnabled).toBe(false);
      expect(parseConfig(base).salesforceSignInEnabled).toBe(false);
    });
    it('keeps both features independent when both redirects are set', () => {
      const cfg = parseConfig({ ...base, SALESFORCE_CLIENT_ID: 'c', SALESFORCE_REDIRECT_URI: 'http://localhost:4100/api/connections/salesforce/callback', SALESFORCE_SIGNIN_REDIRECT_URI: signIn });
      expect(cfg.salesforceEnabled).toBe(true);
      expect(cfg.salesforceSignInEnabled).toBe(true);
    });
    it('requires the client id with a sign-in redirect', () => {
      expect(() => parseConfig({ ...base, SALESFORCE_SIGNIN_REDIRECT_URI: signIn })).toThrow(/SALESFORCE_CLIENT_ID/);
    });
    it('requires a redirect when the client id is set, naming both', () => {
      const attempt = () => parseConfig({ ...base, SALESFORCE_CLIENT_ID: '3MVG9-client' });
      expect(attempt).toThrow(/SALESFORCE_REDIRECT_URI/);
      expect(attempt).toThrow(/SALESFORCE_SIGNIN_REDIRECT_URI/);
    });
    it.each(['00D000000000001', '00D000000000001AAA'])('accepts the org id %s', (id) => {
      expect(parseConfig({ ...base, SALESFORCE_ALLOWED_ORG_ID: id }).SALESFORCE_ALLOWED_ORG_ID).toBe(id);
    });
    it('rejects a malformed org id', () => {
      expect(() => parseConfig({ ...base, SALESFORCE_ALLOWED_ORG_ID: '00D-bad' })).toThrow(/SALESFORCE_ALLOWED_ORG_ID/);
    });
    it('treats empty strings as unset', () => {
      const cfg = parseConfig({ ...base, SALESFORCE_SIGNIN_REDIRECT_URI: '', SALESFORCE_ALLOWED_ORG_ID: '' });
      expect(cfg.SALESFORCE_SIGNIN_REDIRECT_URI).toBeUndefined();
      expect(cfg.SALESFORCE_ALLOWED_ORG_ID).toBeUndefined();
      expect(cfg.salesforceSignInEnabled).toBe(false);
    });
  });
  it('defaults the Salesforce login url and api version, strips a trailing slash, and rejects a malformed version', () => {
    const cfg = parseConfig(base);
    expect(cfg.SALESFORCE_LOGIN_URL).toBe('https://login.salesforce.com');
    expect(cfg.SALESFORCE_API_VERSION).toBe('v60.0');
    expect(parseConfig({ ...base, SALESFORCE_LOGIN_URL: 'https://test.salesforce.com/' }).SALESFORCE_LOGIN_URL).toBe('https://test.salesforce.com');
    expect(parseConfig({ ...base, SALESFORCE_API_VERSION: 'v61.0' }).SALESFORCE_API_VERSION).toBe('v61.0');
    expect(() => parseConfig({ ...base, SALESFORCE_API_VERSION: '60.0' })).toThrow(/SALESFORCE_API_VERSION/);
  });
  it('enables AI only when ANTHROPIC_API_KEY is set (empty counts as unset)', () => {
    expect(parseConfig(base).aiEnabled).toBe(false);
    expect(parseConfig({ ...base, ANTHROPIC_API_KEY: '' }).aiEnabled).toBe(false);
    expect(parseConfig({ ...base, ANTHROPIC_API_KEY: 'sk-ant-test' }).aiEnabled).toBe(true);
  });
  it('defaults CALL_PLAN_MODEL to claude-sonnet-5-5 (empty counts as unset) and takes a configured one', () => {
    expect(parseConfig(base).CALL_PLAN_MODEL).toBe('claude-sonnet-5-5');
    expect(parseConfig({ ...base, CALL_PLAN_MODEL: '' }).CALL_PLAN_MODEL).toBe('claude-sonnet-5-5');
    expect(parseConfig({ ...base, CALL_PLAN_MODEL: 'claude-opus-5' }).CALL_PLAN_MODEL).toBe('claude-opus-5');
  });
  it('defaults WRITEBACK_MODEL to claude-sonnet-5-5 (empty counts as unset) and takes a configured one', () => {
    expect(parseConfig(base).WRITEBACK_MODEL).toBe('claude-sonnet-5-5');
    expect(parseConfig({ ...base, WRITEBACK_MODEL: '' }).WRITEBACK_MODEL).toBe('claude-sonnet-5-5');
    expect(parseConfig({ ...base, WRITEBACK_MODEL: 'claude-opus-5' }).WRITEBACK_MODEL).toBe('claude-opus-5');
  });
  describe('the internal AI call trigger (plan 1C)', () => {
    const secret = 'k'.repeat(32);
    const url = 'http://ctiapi.railway.internal:4000';
    it('is enabled only when CTI_INTERNAL_URL and OUTREACH_INTERNAL_SECRET are both set', () => {
      expect(parseConfig(base).aiCallsEnabled).toBe(false);
      expect(parseConfig({ ...base, CTI_INTERNAL_URL: url }).aiCallsEnabled).toBe(false);
      expect(parseConfig({ ...base, OUTREACH_INTERNAL_SECRET: secret }).aiCallsEnabled).toBe(false);
      expect(parseConfig({ ...base, CTI_INTERNAL_URL: '', OUTREACH_INTERNAL_SECRET: secret }).aiCallsEnabled).toBe(false);
      const cfg = parseConfig({ ...base, CTI_INTERNAL_URL: url, OUTREACH_INTERNAL_SECRET: secret });
      expect(cfg.aiCallsEnabled).toBe(true);
      expect(cfg.CTI_INTERNAL_URL).toBe(url);
      expect(cfg.OUTREACH_INTERNAL_SECRET).toBe(secret);
    });
    it('rejects a secret shorter than 32 characters and a malformed url', () => {
      expect(() => parseConfig({ ...base, OUTREACH_INTERNAL_SECRET: 'k'.repeat(31) })).toThrow(/OUTREACH_INTERNAL_SECRET/);
      expect(() => parseConfig({ ...base, CTI_INTERNAL_URL: 'ctiapi.railway.internal' })).toThrow(/CTI_INTERNAL_URL/);
    });
  });
  it('S-7: CTI_INTERNAL_URL must be an origin: a path, query, fragment or credentials would silently change what is signed and called', () => {
    for (const bad of ['http://ctiapi.railway.internal:4000/api', 'http://ctiapi.railway.internal:4000/x/', 'http://ctiapi.railway.internal?a=1', 'http://ctiapi.railway.internal#f', 'http://u:p@ctiapi.railway.internal:4000']) {
      expect(() => parseConfig({ ...base, CTI_INTERNAL_URL: bad }), bad).toThrow(/CTI_INTERNAL_URL must be an origin/);
    }
    for (const good of ['http://ctiapi.railway.internal:4000', 'http://ctiapi.railway.internal:4000/', 'https://cti.example.com']) {
      expect(parseConfig({ ...base, CTI_INTERNAL_URL: good }).CTI_INTERNAL_URL).toBe(good);
    }
  });
  it('M-5: CTI_INTERNAL_URL must be http: or https:', () => {
    for (const bad of ['ftp://ctiapi.railway.internal:4000', 'file:///etc/passwd', 'ws://ctiapi.railway.internal:4000', 'javascript:alert(1)']) {
      expect(() => parseConfig({ ...base, CTI_INTERNAL_URL: bad }), bad).toThrow(/CTI_INTERNAL_URL/);
    }
    expect(() => parseConfig({ ...base, CTI_INTERNAL_URL: 'ftp://ctiapi.railway.internal:4000' })).toThrow(/http: or https:/);
  });
  describe('AI_CALL_DEFAULT_SPECIALISTS (plan 1D: the default appointment owner list)', () => {
    it('defaults to an empty list (empty counts as unset)', () => {
      expect(parseConfig(base).AI_CALL_DEFAULT_SPECIALISTS).toEqual([]);
      expect(parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: '' }).AI_CALL_DEFAULT_SPECIALISTS).toEqual([]);
    });
    it('parses one id', () => {
      expect(parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: '0058X00000Fsx39QAB' }).AI_CALL_DEFAULT_SPECIALISTS).toEqual(['0058X00000Fsx39QAB']);
    });
    it('parses an ordered list, trimming spaces, dropping empty entries and repeats', () => {
      expect(parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: ' 0058X00000Fsx39QAB, 005000000000002,,0058X00000Fsx39QAB ' }).AI_CALL_DEFAULT_SPECIALISTS).toEqual([
        '0058X00000Fsx39QAB',
        '005000000000002',
      ]);
    });
    it.each(['abc', '00Q8X00000Fsx39QAB', '0058X00000Fsx39QAB,abc', "0058X00000Fsx39Q'B"])('fails startup with a clear message for %s', (bad) => {
      expect(() => parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: bad })).toThrow(/AI_CALL_DEFAULT_SPECIALISTS/);
      expect(() => parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: bad })).toThrow(/Salesforce User ids/);
    });
    it('fails startup for more than 20 ids', () => {
      const ids = Array.from({ length: 21 }, (_, i) => `005000000000${String(i).padStart(3, '0')}`).join(',');
      expect(() => parseConfig({ ...base, AI_CALL_DEFAULT_SPECIALISTS: ids })).toThrow(/AI_CALL_DEFAULT_SPECIALISTS/);
    });
  });
  it('rejects a bad encryption key with a clear message', () => {
    expect(() => parseConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
