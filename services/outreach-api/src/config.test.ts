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
  it('rejects a bad encryption key with a clear message', () => {
    expect(() => parseConfig({ ...base, TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});
