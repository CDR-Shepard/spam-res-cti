import { describe, expect, it } from 'vitest';
import { percentile, TurnStatsCollector } from './bridge-turn-stats.js';

describe('percentile (nearest rank)', () => {
  it('picks the nearest-rank value', () => {
    const xs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(xs, 50)).toBe(500);
    expect(percentile(xs, 90)).toBe(900);
    expect(percentile(xs, 100)).toBe(1000);
    expect(percentile([42], 90)).toBe(42);
  });
});

describe('TurnStatsCollector', () => {
  it('pairs each caller stop with the next agent audio', () => {
    const s = new TurnStatsCollector('gate');
    s.callerStopped(1000, 10_000);
    s.agentAudio(10_800); // total 1800
    s.agentAudio(11_000); // no caller stop pending: ignored
    s.callerStopped(500, 20_000);
    s.agentAudio(20_700); // total 1200
    expect(s.summary()).toEqual({
      v: 1, bargeIn: 'gate', turns: 2,
      totalMs: { p50: 1200, p90: 1800, max: 1800 },
      endpointMs: { p50: 500 }, answerMs: { p50: 700 },
      interruptions: 0, listening: 0, silenceChecks: 0,
    });
  });

  it('clamps a negative endpoint to 0 and drops a pending stop on request', () => {
    const s = new TurnStatsCollector('instant');
    s.callerStopped(-40, 1000);
    s.agentAudio(1500);
    s.callerStopped(300, 5000);
    s.dropPending();
    s.agentAudio(9000);
    expect(s.summary()).toMatchObject({ turns: 1, totalMs: { p50: 500, p90: 500, max: 500 }, endpointMs: { p50: 0 } });
  });

  it('counts interruptions, listening sounds and silence checks; null blocks with no turns', () => {
    const s = new TurnStatsCollector('gate');
    s.interruption();
    s.listeningSound();
    s.listeningSound();
    s.silenceCheck();
    expect(s.summary()).toEqual({
      v: 1, bargeIn: 'gate', turns: 0, totalMs: null, endpointMs: null, answerMs: null,
      interruptions: 1, listening: 2, silenceChecks: 1,
    });
  });
});
