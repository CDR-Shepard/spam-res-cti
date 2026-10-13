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

  it('an overlap stop is a turn only once it is answered, timed from that stop', () => {
    const s = new TurnStatsCollector('gate');
    s.overlapStopped('c1', 400, 1000);
    s.agentAudio(1500); // the agent kept talking: not an answer
    s.overlapsAnswered(['c1']);
    s.agentAudio(1800);
    s.overlapsAnswered(['c1']); // already answered: nothing left to time
    s.agentAudio(2500);
    expect(s.summary()).toMatchObject({ turns: 1, endpointMs: { p50: 400 }, answerMs: { p50: 800 } });
  });

  it('an ignored or cleared overlap is never a turn', () => {
    const s = new TurnStatsCollector('gate');
    s.overlapStopped('c1', 100, 1000);
    s.overlapIgnored('c1');
    s.overlapStopped('c2', 100, 2000);
    s.clearOverlaps();
    s.overlapsAnswered(['c1', 'c2']);
    s.agentAudio(3000);
    expect(s.summary().turns).toBe(0);
  });

  it('one answer to several overlaps times the most recent; a later caller stop still wins', () => {
    const s = new TurnStatsCollector('gate');
    s.overlapStopped('c1', 100, 1000);
    s.overlapStopped('c2', 200, 2000);
    s.overlapsAnswered(['c1', 'c2']);
    s.agentAudio(2500); // c2: 200 + 500
    s.overlapStopped('c3', 300, 4000);
    s.callerStopped(50, 5000);
    s.overlapsAnswered(['c3']); // older than the pending stop
    s.agentAudio(5600); // the 5000 stop: 50 + 600
    expect(s.summary()).toMatchObject({ turns: 2, totalMs: { p50: 650, max: 700 }, endpointMs: { p50: 50 }, answerMs: { p50: 500 } });
  });

  it('a late answer is timed from when the agent’s own audio finished, not from the caller’s stop', () => {
    const s = new TurnStatsCollector('gate');
    s.overlapStopped('c1', 100, 1000);
    s.overlapsAnswered(['c1'], true); // the agent is still playing
    s.agentFinished(1600);
    s.agentAudio(2000); // 400 after its audio finished
    s.overlapStopped('c2', 100, 3000);
    s.agentFinished(3200); // finished before the verdict
    s.overlapsAnswered(['c2']);
    s.agentAudio(3500); // 300 after
    expect(s.summary()).toMatchObject({ turns: 2, endpointMs: { p50: 100 }, totalMs: { p50: 400, max: 500 } });
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
