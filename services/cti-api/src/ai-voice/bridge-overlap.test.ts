import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_WORDS_INTERRUPT_MS, OverlapGate } from './bridge-overlap.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function gate() {
  const onInterrupt = vi.fn();
  const onListening = vi.fn();
  const g = new OverlapGate({ setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h), onInterrupt, onListening });
  return { g, onInterrupt, onListening };
}

describe('OverlapGate', () => {
  it('keeps quiet through listening sounds and ignores them at the end', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Mm');
    g.onDelta('c1', '-hmm');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
    expect(g.itemId).toBeNull();
  });

  it('interrupts on a stop word as soon as it streams in, and closes', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
    expect(g.itemId).toBeNull();
    g.onDelta('c1', ' hold on');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('interrupts on the second real word', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', " I'm");
    expect(onInterrupt).not.toHaveBeenCalled();
    g.onDelta('c1', ' interested');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
  });

  it('interrupts after 3 s of talk with no word at all', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS - 1);
    expect(onInterrupt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onInterrupt).toHaveBeenCalledWith('no words', 'c1');
    expect(g.itemId).toBeNull();
  });

  it('passes the interrupted item id', () => {
    const { g, onInterrupt } = gate();
    g.open('c7', { cuttable: true, late: false });
    g.onDelta('c7', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c7');
  });

  it('a wordless sound that stops before the timer is settled by the final text, not cut', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    vi.advanceTimersByTime(800);
    g.onSpeechStopped('c1');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', '')).toBe('ignore');
  });

  it('onSpeechStopped for another item leaves the timer armed', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onSpeechStopped('c2');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS);
    expect(onInterrupt).toHaveBeenCalledWith('no words', 'c1');
  });

  it('an uncuttable overlap never arms the no-words timer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 3);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.itemId).toBe('c1');
  });

  it('a blank final transcript falls back to the streamed words', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', " I'm");
    expect(g.finish('c1', '')).toBe('ignore');
    g.open('c2', { cuttable: true, late: true });
    g.onDelta('c2', ' Yeah');
    expect(g.finish('c2', '   ')).toBe('answer');
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('ignores deltas for other items', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c2', ' Wait');
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.itemId).toBe('c1');
  });

  it('a late listening sound is an answer', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.onDelta('c1', ' Yeah sure');
    expect(g.finish('c1', 'Yeah, sure.')).toBe('answer');
  });

  it('a wordless late overlap (a cough near the end) is ignored, not answered', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.onSpeechStopped('c1');
    expect(g.finish('c1', '')).toBe('ignore');
    g.open('c2', { cuttable: false, late: true });
    expect(g.finish('c2', '  ')).toBe('ignore');
  });

  it('settles on the final text when the words arrived late', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    expect(g.finish('c1', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
  });

  it('never cuts an uncuttable overlap (the opener) — a real interruption becomes an answer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    g.onDelta('c1', ' Wait who is this');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Wait, who is this?')).toBe('answer');
  });

  it('an uncuttable listening sound that is not late is ignored', () => {
    const { g } = gate();
    g.open('c1', { cuttable: false, late: false });
    expect(g.finish('c1', 'Hello?')).toBe('ignore');
  });

  it('opening a new overlap or close() cancels the no-words timer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.open('c2', { cuttable: true, late: false });
    g.close();
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c2', 'Wait')).toBe('ignore');
  });

  it('an overlap pushed aside by new speech is still judged by its words, and a cut settles both', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onSpeechStopped('c1');
    g.open('c2', { cuttable: true, late: false });
    expect(g.has('c1')).toBe(true);
    expect(g.has('c2')).toBe(true);
    g.onDelta('c1', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
    expect(g.has('c1')).toBe(false);
    expect(g.itemId).toBeNull();
  });

  it('a pushed-aside overlap settles on its final text and leaves the current one alone', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.open('c2', { cuttable: true, late: false });
    expect(g.finish('c1', 'Yeah, sure.')).toBe('answer');
    expect(g.has('c1')).toBe(false);
    expect(g.itemId).toBe('c2');
    g.open('c3', { cuttable: false, late: false });
    expect(g.finish('c2', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c2');
    expect(g.has('c3')).toBe(false);
  });

  it('is idle only when no overlap is being judged, current or pushed aside', () => {
    const { g } = gate();
    expect(g.idle).toBe(true);
    g.open('c1', { cuttable: true, late: false });
    expect(g.idle).toBe(false);
    g.open('c2', { cuttable: true, late: false }); // c1 pushed aside
    expect(g.finish('c2', 'Mm-hmm.')).toBe('ignore');
    expect(g.itemId).toBeNull();
    expect(g.idle).toBe(false); // c1 is still being judged
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
    expect(g.idle).toBe(true);
    g.open('c3', { cuttable: true, late: false });
    g.close();
    expect(g.idle).toBe(true);
  });

  it('close() forgets pushed-aside overlaps too', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.open('c2', { cuttable: true, late: false });
    g.close();
    expect(g.has('c1')).toBe(false);
    expect(g.finish('c1', 'Wait')).toBe('ignore');
  });
});

describe('OverlapGate — the caller is still talking when the agent finishes (final review F5)', () => {
  it('a listening sound still going when the agent finishes is their answer', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: false }); // began 2.5 s before the end
    g.onDelta('c1', ' Yeah');
    g.onAgentFinished();
    g.onSpeechStopped('c1');
    expect(g.finish('c1', 'Yeah.')).toBe('answer');
  });

  it('a listening sound that stopped before the agent finished stays ignored, even if judged after', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onSpeechStopped('c1');
    g.onAgentFinished();
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
  });

  it('a cough still going when the agent finishes is still ignored', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onAgentFinished();
    g.onSpeechStopped('c1');
    expect(g.finish('c1', '')).toBe('ignore');
  });

  it('an interruption still going when the agent finishes is judged as before', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onAgentFinished();
    expect(g.finish('c1', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
  });

  it('over the opener: a listening sound still going when it finishes is the answer; a real one is answered as before', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    g.onAgentFinished();
    expect(g.finish('c1', 'Hello?')).toBe('answer');
    g.open('c2', { cuttable: false, late: false });
    g.onAgentFinished();
    expect(g.finish('c2', 'Wait, who is this?')).toBe('answer');
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('does nothing with no overlap open', () => {
    const { g } = gate();
    g.onAgentFinished();
    expect(g.idle).toBe(true);
  });
});

describe('OverlapGate — listening sounds are reported only with words (final review F7)', () => {
  it('reports an ignored overlap as a listening sound only when it had a word', () => {
    const { g, onListening } = gate();
    g.open('c1', { cuttable: true, late: false });
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith('c1');
    g.open('c2', { cuttable: true, late: false });
    expect(g.finish('c2', '')).toBe('ignore'); // a cough or a failed transcription
    g.open('c3', { cuttable: true, late: true });
    expect(g.finish('c3', '')).toBe('ignore'); // a cough near the end
    g.open('c4', { cuttable: true, late: true });
    expect(g.finish('c4', 'Yeah, sure.')).toBe('answer');
    g.open('c5', { cuttable: true, late: false });
    expect(g.finish('c5', 'Who is this?')).toBe('interrupted');
    expect(onListening).toHaveBeenCalledTimes(1);
  });

  it('a blank final transcript after streamed words still counts the words', () => {
    const { g, onListening } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Okay');
    expect(g.finish('c1', '  ')).toBe('ignore');
    expect(onListening).toHaveBeenCalledWith('c1');
  });
});
