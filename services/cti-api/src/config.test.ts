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
    'AI_VOICE_BARGE_IN', 'AI_VOICE_TRANSCRIBE_MODEL', 'AI_VOICE_TURN_DETECTION', 'AI_VOICE_SILENCE_MS',
    'AI_VOICE_OVERLAP_JUDGE', 'AI_VOICE_STOP_MS', 'AI_VOICE_INBOUND',
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
    expect(cfg.AI_VOICE_BARGE_IN).toBe('gate');
    expect(cfg.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-live-transcribe');
    expect(cfg.AI_VOICE_TURN_DETECTION).toBe('server_vad');
    expect(cfg.AI_VOICE_SILENCE_MS).toBe(500);
    expect(cfg.AI_VOICE_OVERLAP_JUDGE).toBe('sound');
    expect(cfg.AI_VOICE_STOP_MS).toBe(600);
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
      AI_VOICE_BARGE_IN: 'instant', AI_VOICE_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe',
      AI_VOICE_MAX_CALL_SECONDS: '120', OUTREACH_KILL_SWITCH: 'on',
    });
    expect(cfg.AI_VOICE).toBe('off');
    expect(cfg.AI_VOICE_REASONING).toBe('high');
    expect(cfg.AI_VOICE_VAD_EAGERNESS).toBe('low');
    expect(cfg.AI_VOICE_BARGE_IN).toBe('instant');
    expect(cfg.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(cfg.AI_VOICE_MAX_CALL_SECONDS).toBe(120);
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('on');
  });

  it('AI_VOICE_INBOUND (test phones calling an AI number get the agent) is on or off, default on (empty = unset)', async () => {
    expect((await loadWith({})).AI_VOICE_INBOUND).toBe('on');
    expect((await loadWith({ AI_VOICE_INBOUND: '' })).AI_VOICE_INBOUND).toBe('on');
    expect((await loadWith({ AI_VOICE_INBOUND: 'off' })).AI_VOICE_INBOUND).toBe('off');
    await expect(loadWith({ AI_VOICE_INBOUND: 'false' })).rejects.toThrow(/AI_VOICE_INBOUND/);
  });

  it('strict enums fail the boot loudly', async () => {
    await expect(loadWith({ AI_VOICE: 'false' })).rejects.toThrow(/AI_VOICE/);
    await expect(loadWith({ OUTREACH_KILL_SWITCH: '1' })).rejects.toThrow(/OUTREACH_KILL_SWITCH/);
    await expect(loadWith({ AI_VOICE_REASONING: 'extreme' })).rejects.toThrow(/AI_VOICE_REASONING/);
    await expect(loadWith({ AI_VOICE_BARGE_IN: 'sometimes' })).rejects.toThrow(/AI_VOICE_BARGE_IN/);
  });

  it('the transcriber follows the barge-in mode when unset, so instant alone is the whole rollback', async () => {
    expect((await loadWith({})).AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-live-transcribe');
    expect((await loadWith({ AI_VOICE_BARGE_IN: 'gate' })).AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-live-transcribe');
    expect((await loadWith({ AI_VOICE_BARGE_IN: 'instant' })).AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    const emptyInstant = await loadWith({ AI_VOICE_BARGE_IN: 'instant', AI_VOICE_TRANSCRIBE_MODEL: '' });
    expect(emptyInstant.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    const emptyGate = await loadWith({ AI_VOICE_BARGE_IN: '', AI_VOICE_TRANSCRIBE_MODEL: '' });
    expect(emptyGate.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-live-transcribe');
  });

  it('an explicit transcriber wins in either mode', async () => {
    const gate = await loadWith({ AI_VOICE_BARGE_IN: 'gate', AI_VOICE_TRANSCRIBE_MODEL: 'gpt-4o-mini-transcribe' });
    expect(gate.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    const instant = await loadWith({ AI_VOICE_BARGE_IN: 'instant', AI_VOICE_TRANSCRIBE_MODEL: 'gpt-live-transcribe' });
    expect(instant.AI_VOICE_TRANSCRIBE_MODEL).toBe('gpt-live-transcribe');
  });

  it('turn detection follows the barge-in mode when unset: gate = server_vad, instant keeps semantic_vad', async () => {
    expect((await loadWith({})).AI_VOICE_TURN_DETECTION).toBe('server_vad');
    expect((await loadWith({ AI_VOICE_BARGE_IN: 'gate' })).AI_VOICE_TURN_DETECTION).toBe('server_vad');
    expect((await loadWith({ AI_VOICE_BARGE_IN: 'instant' })).AI_VOICE_TURN_DETECTION).toBe('semantic_vad');
    const emptyInstant = await loadWith({ AI_VOICE_BARGE_IN: 'instant', AI_VOICE_TURN_DETECTION: '' });
    expect(emptyInstant.AI_VOICE_TURN_DETECTION).toBe('semantic_vad');
    const emptyGate = await loadWith({ AI_VOICE_BARGE_IN: '', AI_VOICE_TURN_DETECTION: '' });
    expect(emptyGate.AI_VOICE_TURN_DETECTION).toBe('server_vad');
  });

  it('an explicit turn detection wins in either mode, so semantic_vad alone rolls back just the VAD', async () => {
    const gate = await loadWith({ AI_VOICE_BARGE_IN: 'gate', AI_VOICE_TURN_DETECTION: 'semantic_vad' });
    expect(gate.AI_VOICE_TURN_DETECTION).toBe('semantic_vad');
    const instant = await loadWith({ AI_VOICE_BARGE_IN: 'instant', AI_VOICE_TURN_DETECTION: 'server_vad' });
    expect(instant.AI_VOICE_TURN_DETECTION).toBe('server_vad');
  });

  it('an unknown turn detection fails the boot loudly', async () => {
    await expect(loadWith({ AI_VOICE_TURN_DETECTION: 'fast' })).rejects.toThrow(/AI_VOICE_TURN_DETECTION/);
  });

  it('the silence wait is an integer of 200 to 2000 ms, default 500 (empty = unset)', async () => {
    expect((await loadWith({})).AI_VOICE_SILENCE_MS).toBe(500);
    expect((await loadWith({ AI_VOICE_SILENCE_MS: '' })).AI_VOICE_SILENCE_MS).toBe(500);
    expect((await loadWith({ AI_VOICE_SILENCE_MS: '200' })).AI_VOICE_SILENCE_MS).toBe(200);
    expect((await loadWith({ AI_VOICE_SILENCE_MS: '800' })).AI_VOICE_SILENCE_MS).toBe(800);
    expect((await loadWith({ AI_VOICE_SILENCE_MS: '2000' })).AI_VOICE_SILENCE_MS).toBe(2000);
    for (const bad of ['199', '2001', '0', '-500', '500.5', 'soon']) {
      await expect(loadWith({ AI_VOICE_SILENCE_MS: bad })).rejects.toThrow(/AI_VOICE_SILENCE_MS/);
    }
  });

  it('the overlap judge is sound or words, default sound (empty = unset); anything else fails the boot', async () => {
    expect((await loadWith({ AI_VOICE_OVERLAP_JUDGE: '' })).AI_VOICE_OVERLAP_JUDGE).toBe('sound');
    expect((await loadWith({ AI_VOICE_OVERLAP_JUDGE: 'sound' })).AI_VOICE_OVERLAP_JUDGE).toBe('sound');
    expect((await loadWith({ AI_VOICE_OVERLAP_JUDGE: 'words' })).AI_VOICE_OVERLAP_JUDGE).toBe('words');
    for (const bad of ['Sound', 'both', 'off']) {
      await expect(loadWith({ AI_VOICE_OVERLAP_JUDGE: bad })).rejects.toThrow(/AI_VOICE_OVERLAP_JUDGE/);
    }
  });

  it('the stop length is an integer of 300 to 2000 ms, default 600 (empty = unset)', async () => {
    expect((await loadWith({ AI_VOICE_STOP_MS: '' })).AI_VOICE_STOP_MS).toBe(600);
    expect((await loadWith({ AI_VOICE_STOP_MS: '300' })).AI_VOICE_STOP_MS).toBe(300);
    expect((await loadWith({ AI_VOICE_STOP_MS: '750' })).AI_VOICE_STOP_MS).toBe(750);
    expect((await loadWith({ AI_VOICE_STOP_MS: '2000' })).AI_VOICE_STOP_MS).toBe(2000);
    for (const bad of ['299', '2001', '0', '-600', '600.5', 'soon']) {
      await expect(loadWith({ AI_VOICE_STOP_MS: bad })).rejects.toThrow(/AI_VOICE_STOP_MS/);
    }
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
