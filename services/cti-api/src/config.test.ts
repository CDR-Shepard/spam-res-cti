/**
 * loadConfig caches its first parse for the life of the module, so every case
 * re-imports the module fresh against its own process.env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED = {
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  SESSION_SECRET: 's'.repeat(32),
  DATABASE_URL: 'postgres://user:pw@localhost:5432/cti_test',
};

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...REQUIRED, ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { loadConfig } = await import('./config.js');
  return loadConfig();
}

describe('NO_ANSWER_CHATTER — the end-of-run "No answer" Chatter kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.NO_ANSWER_CHATTER; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON — the feature ships enabled; the variable exists to turn it OFF', async () => {
    expect((await loadWith({ NO_ANSWER_CHATTER: undefined })).NO_ANSWER_CHATTER).toBe('on');
  });

  it('an empty value (Railway\'s "suggested variables") is treated as unset → on', async () => {
    expect((await loadWith({ NO_ANSWER_CHATTER: '' })).NO_ANSWER_CHATTER).toBe('on');
  });

  it('off turns it off', async () => {
    expect((await loadWith({ NO_ANSWER_CHATTER: 'off' })).NO_ANSWER_CHATTER).toBe('off');
  });

  it('anything else fails the boot loudly rather than guessing what "false" or "0" meant', async () => {
    await expect(loadWith({ NO_ANSWER_CHATTER: 'false' })).rejects.toThrow(/NO_ANSWER_CHATTER/);
  });
});
