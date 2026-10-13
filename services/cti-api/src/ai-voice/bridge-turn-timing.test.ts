import { describe, expect, it, vi } from 'vitest';
import { TurnTiming, heldBy } from './bridge-turn-timing.js';

function timing(bargeIn: 'gate' | 'instant' = 'gate') {
  const emit = vi.fn();
  return { t: new TurnTiming(bargeIn, 'server_vad', emit), emit };
}

/** A plain turn: stop at 1000, then answered by the first audio at 1860 on mark `agent-1`. */
function answered(t: TurnTiming) {
  t.stopped('c1', 1000, false, false);
  t.committed('c1', 1040);
  t.requested(1040);
  t.created(1160);
  t.delta(1860);
  t.forwarded(1860, 'agent-1');
}

describe('heldBy', () => {
  it('names the first thing that holds a response.create, in the bridge order', () => {
    expect(heldBy(true, true, true)).toBe('caller_talking');
    expect(heldBy(false, true, true)).toBe('response_active');
    expect(heldBy(false, false, true)).toBe('tools');
    expect(heldBy(false, false, false)).toBeNull();
  });
});

describe('TurnTiming', () => {
  it('logs a normal turn once, when its first mark echoes, every figure relative to the stop', () => {
    const { t, emit } = timing();
    answered(t);
    expect(emit).not.toHaveBeenCalled(); // not played yet
    t.played('agent-1', 1890);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      committedMs: 40,
      requestedMs: 40,
      deferred: null,
      createdMs: 160,
      firstDeltaMs: 860,
      forwardedMs: 860,
      playedMs: 890,
      responses: 1,
      toolBatches: 0,
      overlap: false,
      late: false,
      bargeIn: 'gate',
      turnDetection: 'server_vad',
    });
    t.played('agent-1', 2000); // echoed again, or flushed later: still once
    t.speechStarted();
    t.end();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('only the first chunk\'s mark counts as played', () => {
    const { t, emit } = timing();
    answered(t);
    t.played('agent-9', 1900);
    t.played('agent-2', 1900);
    expect(emit).not.toHaveBeenCalled();
    t.played('agent-1', 1950);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ playedMs: 950 }));
  });

  it('an answered turn whose audio is never confirmed logs with playedMs null at the next speech_started', () => {
    const { t, emit } = timing();
    answered(t);
    t.speechStarted();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ forwardedMs: 860, playedMs: null }));
    t.played('agent-1', 3000); // too late: already logged
    t.end();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('end() logs an answered turn that never played, once', () => {
    const { t, emit } = timing();
    answered(t);
    t.end();
    t.end();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ playedMs: null }));
  });

  it('a turn that is never answered logs nothing', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, false, false);
    t.committed('c1', 1040);
    t.requested(1040);
    t.created(1100);
    t.speechStarted();
    t.end();
    expect(emit).not.toHaveBeenCalled();
  });

  it('audio with no turn pending (the opener, a check-in) logs nothing', () => {
    const { t, emit } = timing();
    t.created(10);
    t.delta(500);
    t.forwarded(500, 'agent-1');
    t.played('agent-1', 600);
    t.end();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a function-call-first turn counts both responses and the tool batch; the first delta is the answering response\'s', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, false, false);
    t.committed('c1', 1030);
    t.requested(1030);
    t.created(1130); // response 1: a function call only
    t.toolBatch();
    t.requested(1330); // the follow-up create
    t.created(1380); // response 2
    t.delta(1680);
    t.delta(1700);
    t.forwarded(1680, 'agent-5');
    t.played('agent-5', 1700);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMs: 30, createdMs: 130, firstDeltaMs: 680, forwardedMs: 680, playedMs: 700, responses: 2, toolBatches: 1 }),
    );
  });

  it('keeps the first reason an answer was held, and none once the create has been sent', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, false, false);
    t.deferred('caller_talking');
    t.deferred('tools');
    t.requested(1500);
    t.deferred('response_active'); // a later hold of the same turn (a follow-up) is not "the first attempt"
    t.created(1600);
    t.delta(1900);
    t.forwarded(1900, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ deferred: 'caller_talking', requestedMs: 500 }));
  });

  it('a hold with no turn pending is ignored', () => {
    const { t, emit } = timing();
    t.deferred('tools');
    t.stopped('c1', 1000, false, false);
    t.requested(1010);
    t.created(1020);
    t.delta(1100);
    t.forwarded(1100, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ deferred: null }));
  });

  it('an overlap is a turn only once answered, timed from its own stop, with its hold and lateness', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, true, true);
    t.committed('c1', 1050);
    t.deferred('overlap_verdict', 'c1');
    t.delta(1100);
    t.forwarded(1100, 'agent-1'); // the agent kept talking: not an answer
    t.played('agent-1', 1110);
    expect(emit).not.toHaveBeenCalled();
    t.overlapsAnswered(['c1']);
    t.requested(2000);
    t.created(2100);
    t.delta(2400);
    t.forwarded(2400, 'agent-7');
    t.played('agent-7', 2450);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      committedMs: 50,
      requestedMs: 1000,
      deferred: 'overlap_verdict',
      createdMs: 1100,
      firstDeltaMs: 1400,
      forwardedMs: 1400,
      playedMs: 1450,
      responses: 1,
      toolBatches: 0,
      overlap: true,
      late: true,
      bargeIn: 'gate',
      turnDetection: 'server_vad',
    });
  });

  it('an overlap answered while the agent still plays is held after_playback, unless something held it first', () => {
    const a = timing();
    a.t.stopped('c1', 1000, true, true);
    a.t.overlapsAnswered(['c1'], true);
    a.t.requested(3000);
    a.t.created(3100);
    a.t.delta(3300);
    a.t.forwarded(3300, 'agent-1');
    a.t.end();
    expect(a.emit).toHaveBeenCalledWith(expect.objectContaining({ deferred: 'after_playback' }));

    const b = timing();
    b.t.stopped('c1', 1000, true, true);
    b.t.deferred('overlap_verdict', 'c1');
    b.t.overlapsAnswered(['c1'], true);
    b.t.delta(3300);
    b.t.forwarded(3300, 'agent-1');
    b.t.end();
    expect(b.emit).toHaveBeenCalledWith(expect.objectContaining({ deferred: 'overlap_verdict' }));
  });

  it('an ignored overlap, a dropped turn, or an overlap answered by a newer pending turn is not logged as the answer', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, true, false);
    t.ignored('c1');
    t.overlapsAnswered(['c1']);
    t.delta(1500);
    t.forwarded(1500, 'agent-1');
    t.stopped('c2', 2000, false, false);
    t.dropPending();
    t.delta(2500);
    t.forwarded(2500, 'agent-2');
    t.end();
    expect(emit).not.toHaveBeenCalled();

    t.stopped('c3', 3000, true, false); // older than the pending turn below: it does not replace it
    t.stopped('c4', 3100, false, false);
    t.overlapsAnswered(['c3']);
    t.delta(3600);
    t.forwarded(3600, 'agent-3');
    t.end();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ forwardedMs: 500, overlap: false }));
  });

  it('a newer stop replaces an unanswered one, and answers are timed from the newer stop', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, false, false);
    t.created(1100); // answered nobody: cancelled unheard
    t.stopped('c2', 2000, false, false);
    t.created(2100);
    t.delta(2700);
    t.forwarded(2700, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ createdMs: 100, forwardedMs: 700, responses: 1 }));
  });

  it('responses and tool batches from before the stop are not counted, and a new response restarts the first-delta clock', () => {
    const { t, emit } = timing();
    t.created(100);
    t.toolBatch();
    t.delta(200); // an earlier response's audio
    t.stopped('c1', 1000, false, false);
    t.created(1100);
    t.delta(1500);
    t.forwarded(1500, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ responses: 1, toolBatches: 0, createdMs: 100, firstDeltaMs: 500 }));
  });

  it('a second answered turn logs the first one (unplayed) before itself: every turn once', () => {
    const { t, emit } = timing('instant');
    answered(t);
    t.stopped('c2', 5000, false, false);
    t.created(5100);
    t.delta(5500);
    t.forwarded(5500, 'agent-4');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ forwardedMs: 860, playedMs: null, bargeIn: 'instant' }));
    t.played('agent-4', 5520);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ forwardedMs: 500, playedMs: 520 }));
  });

  it('a turn the bridge never requested (OpenAI VAD answered it) has requestedMs null', () => {
    const { t, emit } = timing('instant');
    t.stopped('c1', 1000, false, false);
    t.committed('c1', 1020);
    t.created(1100);
    t.delta(1400);
    t.forwarded(1400, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ requestedMs: null, committedMs: 20, bargeIn: 'instant' }));
  });

  it('a commit with no matching stop changes nothing', () => {
    const { t, emit } = timing();
    t.stopped('c1', 1000, false, false);
    t.committed('c9', 1010);
    t.delta(1100);
    t.forwarded(1100, 'agent-1');
    t.end();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ committedMs: null }));
  });
});
