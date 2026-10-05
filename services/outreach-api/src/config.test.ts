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
  it('rejects a bad encryption key with a clear message', () => {
    expect(() => parseConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
