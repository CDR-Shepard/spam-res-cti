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

describe('INBOUND_TEXTS — the inbound-texts (Task + email alert) kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.INBOUND_TEXTS; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON — the variable exists to turn it OFF', async () => {
    expect((await loadWith({ INBOUND_TEXTS: undefined })).INBOUND_TEXTS).toBe('on');
  });

  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ INBOUND_TEXTS: '' })).INBOUND_TEXTS).toBe('on');
  });

  it('off turns it off', async () => {
    expect((await loadWith({ INBOUND_TEXTS: 'off' })).INBOUND_TEXTS).toBe('off');
  });

  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ INBOUND_TEXTS: 'false' })).rejects.toThrow(/INBOUND_TEXTS/);
  });
});

describe('DIALER_RECORDING — the power-dial recording kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.DIALER_RECORDING; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON', async () => {
    expect((await loadWith({ DIALER_RECORDING: undefined })).DIALER_RECORDING).toBe('on');
  });
  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ DIALER_RECORDING: '' })).DIALER_RECORDING).toBe('on');
  });
  it('off turns it off', async () => {
    expect((await loadWith({ DIALER_RECORDING: 'off' })).DIALER_RECORDING).toBe('off');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ DIALER_RECORDING: 'false' })).rejects.toThrow(/DIALER_RECORDING/);
  });
});

describe('DIALER_CONNECT_TASKS — the power-dial Call Task kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.DIALER_CONNECT_TASKS; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: undefined })).DIALER_CONNECT_TASKS).toBe('on');
  });
  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: '' })).DIALER_CONNECT_TASKS).toBe('on');
  });
  it('off turns it off', async () => {
    expect((await loadWith({ DIALER_CONNECT_TASKS: 'off' })).DIALER_CONNECT_TASKS).toBe('off');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ DIALER_CONNECT_TASKS: 'false' })).rejects.toThrow(/DIALER_CONNECT_TASKS/);
  });
});

describe('DIALER_IDLE_STOP — the idle power-dial line kill switch', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.DIALER_IDLE_STOP; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to ON', async () => {
    expect((await loadWith({ DIALER_IDLE_STOP: undefined })).DIALER_IDLE_STOP).toBe('on');
  });
  it('an empty value is treated as unset → on', async () => {
    expect((await loadWith({ DIALER_IDLE_STOP: '' })).DIALER_IDLE_STOP).toBe('on');
  });
  it('off turns it off', async () => {
    expect((await loadWith({ DIALER_IDLE_STOP: 'off' })).DIALER_IDLE_STOP).toBe('off');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ DIALER_IDLE_STOP: 'false' })).rejects.toThrow(/DIALER_IDLE_STOP/);
  });
});

describe('AI voice config', () => {
  const saved = { ...process.env };
  const KEYS = [
    'OPENAI_API_KEY', 'AI_VOICE', 'AI_VOICE_MODEL', 'AI_VOICE_REASONING',
    'AI_VOICE_VAD_EAGERNESS', 'AI_VOICE_VOICE', 'AI_VOICE_AGENT_NAME',
    'AI_VOICE_TEST_NUMBERS', 'AI_VOICE_MAX_CALL_SECONDS', 'ANTHROPIC_API_KEY',
    'AI_SUMMARY_MODEL', 'OUTREACH_KILL_SWITCH',
  ];
  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults', async () => {
    const cfg = await loadWith({});
    expect(cfg.OPENAI_API_KEY).toBeUndefined();
    expect(cfg.AI_VOICE).toBe('on');
    expect(cfg.AI_VOICE_MODEL).toBe('gpt-realtime-2.1');
    expect(cfg.AI_VOICE_REASONING).toBe('low');
    expect(cfg.AI_VOICE_VAD_EAGERNESS).toBe('auto');
    expect(cfg.AI_VOICE_VOICE).toBe('marin');
    expect(cfg.AI_VOICE_AGENT_NAME).toBe('Alex');
    expect(cfg.AI_VOICE_TEST_NUMBERS).toBeUndefined();
    expect(cfg.AI_VOICE_MAX_CALL_SECONDS).toBe(600);
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.AI_SUMMARY_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('off');
  });

  it('empty values are treated as unset', async () => {
    const cfg = await loadWith({ OPENAI_API_KEY: '', AI_VOICE: '', AI_VOICE_MAX_CALL_SECONDS: '', OUTREACH_KILL_SWITCH: '' });
    expect(cfg.OPENAI_API_KEY).toBeUndefined();
    expect(cfg.AI_VOICE).toBe('on');
    expect(cfg.AI_VOICE_MAX_CALL_SECONDS).toBe(600);
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('off');
  });

  it('accepts overrides', async () => {
    const cfg = await loadWith({
      AI_VOICE: 'off', AI_VOICE_REASONING: 'high', AI_VOICE_VAD_EAGERNESS: 'low',
      AI_VOICE_MAX_CALL_SECONDS: '120', OUTREACH_KILL_SWITCH: 'on',
    });
    expect(cfg.AI_VOICE).toBe('off');
    expect(cfg.AI_VOICE_REASONING).toBe('high');
    expect(cfg.AI_VOICE_VAD_EAGERNESS).toBe('low');
    expect(cfg.AI_VOICE_MAX_CALL_SECONDS).toBe(120);
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('on');
  });

  it('strict enums fail the boot loudly', async () => {
    await expect(loadWith({ AI_VOICE: 'false' })).rejects.toThrow(/AI_VOICE/);
    await expect(loadWith({ OUTREACH_KILL_SWITCH: '1' })).rejects.toThrow(/OUTREACH_KILL_SWITCH/);
    await expect(loadWith({ AI_VOICE_REASONING: 'extreme' })).rejects.toThrow(/AI_VOICE_REASONING/);
  });

  it('rejects a non-positive max call length', async () => {
    await expect(loadWith({ AI_VOICE_MAX_CALL_SECONDS: '0' })).rejects.toThrow(/AI_VOICE_MAX_CALL_SECONDS/);
  });
});

describe('parseTestNumbers', () => {
  it('E.164-normalizes each entry and drops invalid ones', async () => {
    vi.resetModules();
    const { parseTestNumbers } = await import('./config.js');
    const out = parseTestNumbers('+15125550100, 5125550101,bad');
    expect([...out].sort()).toEqual(['+15125550100', '+15125550101']);
  });

  it('undefined and empty yield an empty set', async () => {
    vi.resetModules();
    const { parseTestNumbers } = await import('./config.js');
    expect(parseTestNumbers(undefined).size).toBe(0);
    expect(parseTestNumbers('').size).toBe(0);
    expect(parseTestNumbers(' , ,').size).toBe(0);
  });

  it('dedupes equivalent formats', async () => {
    vi.resetModules();
    const { parseTestNumbers } = await import('./config.js');
    expect(parseTestNumbers('(512) 555-0100,+15125550100').size).toBe(1);
  });
});

describe('aiVoiceAvailable', () => {
  type Cfg = Parameters<typeof import('./config.js').aiVoiceAvailable>[0];
  const base: Cfg = { OPENAI_API_KEY: 'sk-test', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off' };
  const cases: Array<[string, Partial<Cfg>, boolean]> = [
    ['key set, AI_VOICE on, kill switch off', {}, true],
    ['no key', { OPENAI_API_KEY: undefined }, false],
    ['AI_VOICE off', { AI_VOICE: 'off' }, false],
    ['kill switch on', { OUTREACH_KILL_SWITCH: 'on' }, false],
    ['everything wrong', { OPENAI_API_KEY: undefined, AI_VOICE: 'off', OUTREACH_KILL_SWITCH: 'on' }, false],
  ];
  it.each(cases)('%s → %s', async (_name, over, expected) => {
    vi.resetModules();
    const { aiVoiceAvailable } = await import('./config.js');
    expect(aiVoiceAvailable({ ...base, ...over })).toBe(expected);
  });
});

describe('OUTREACH_INTERNAL_SECRET (plan 1C internal AI call trigger)', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OUTREACH_INTERNAL_SECRET; });
  afterEach(() => { process.env = { ...saved }; });

  it('is optional: unset (or empty) leaves the internal routes disabled', async () => {
    expect((await loadWith({})).OUTREACH_INTERNAL_SECRET).toBeUndefined();
    expect((await loadWith({ OUTREACH_INTERNAL_SECRET: '' })).OUTREACH_INTERNAL_SECRET).toBeUndefined();
  });
  it('accepts 32 characters or more', async () => {
    expect((await loadWith({ OUTREACH_INTERNAL_SECRET: 'k'.repeat(32) })).OUTREACH_INTERNAL_SECRET).toBe('k'.repeat(32));
  });
  it('a shorter secret fails the boot loudly', async () => {
    await expect(loadWith({ OUTREACH_INTERNAL_SECRET: 'k'.repeat(31) })).rejects.toThrow(/OUTREACH_INTERNAL_SECRET/);
  });
});
