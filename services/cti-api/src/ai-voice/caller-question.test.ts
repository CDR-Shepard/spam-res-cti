import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallerLines, optedOut, waitingOnAnswer } from './caller-question.js';

const line = (text: string, final = true) => ({ text, final });
const timers = { setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms), clearTimer: (h: ReturnType<typeof setTimeout>) => clearTimeout(h) };

describe('waitingOnAnswer', () => {
  it.each([
    "You don't have a rough timeline?",
    "Why is that a, I, I don't understand. Like, you don't have a rough timeline?",
    'What? That’s it?',
    'Thanks, bye. Oh wait, how long does closing take?',
    'So what would you pay?"',
    'Thanks for the info, but how long does closing take?',
  ])('"%s" is waiting on an answer', (text) => {
    expect(waitingOnAnswer([line(text)])).toBe(true);
  });

  it.each([
    'Okay, bye.',
    'Okay, bye?',
    'No, I’m not interested in selling.',
    "We're not selling.",
    'I already sold it.',
    'Leave me alone.',
    'Put me on your do not call list.',
    "Don't ever call here again.",
    'You too, have a great day.',
    'Why is that a team detail',
    'Mm.',
    '',
    // Questions that opt out are honored, not answered.
    'Can you take me off your list?',
    'Why do you keep calling? Stop calling me.',
    'Can you just stop calling?',
  ])('"%s" is not', (text) => {
    expect(waitingOnAnswer([line(text)])).toBe(false);
  });

  it('the last known line decides: a later question wins over an earlier goodbye, and a later goodbye over a question', () => {
    expect(waitingOnAnswer([line("No, that's it, thanks, bye."), line("Oh wait, what's your number?")])).toBe(true);
    expect(waitingOnAnswer([line('How long does it take?'), line('Never mind, bye.')])).toBe(false);
    expect(waitingOnAnswer([line('Why not?'), line('', false)])).toBe(true);
  });

  it('a filler line after a question does not hide it', () => {
    expect(waitingOnAnswer([line("So what's your offer?"), line('Mm.')])).toBe(true);
    expect(waitingOnAnswer([line('How long does closing take?'), line('Uh,'), line('Hmm.')])).toBe(true);
    expect(waitingOnAnswer([line('Mm-hmm.')])).toBe(false);
  });

  it('an opt-out in any line wins', () => {
    expect(waitingOnAnswer([line('Take me off your list.'), line('Why do you even call?')])).toBe(false);
    expect(optedOut([line('please remove me from your list')])).toBe(true);
    expect(optedOut([line('Do you guys take care of closing costs?')])).toBe(false);
  });

  it('streamed words count before the final transcript', () => {
    expect(waitingOnAnswer([line('So how long does it take?', false)])).toBe(true);
  });
});

describe('CallerLines', () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the caller's lines since the agent last spoke: streamed words first, the final transcript when it comes", () => {
    const lines = new CallerLines(timers);
    lines.delta('c1', "You don't");
    lines.delta('c1', ' have a timeline?');
    lines.committed('c1');
    expect(lines.sinceAgent()).toEqual([{ text: "You don't have a timeline?", final: false }]);
    lines.final('c1', "You don't have a rough timeline?");
    lines.delta('c1', ' (late delta)');
    lines.committed('c2');
    expect(lines.sinceAgent()).toEqual([
      { text: "You don't have a rough timeline?", final: true },
      { text: '', final: false },
    ]);
    lines.agentSpoke();
    expect(lines.sinceAgent()).toEqual([]);
  });

  it('a line whose words come after the agent spoke is not counted again, and its words are kept for a later commit', () => {
    const lines = new CallerLines(timers);
    lines.delta('c3', 'Okay');
    lines.agentSpoke();
    lines.final('c3', 'Okay, bye.');
    expect(lines.sinceAgent()).toEqual([]);
    lines.committed('c3');
    expect(lines.sinceAgent()).toEqual([{ text: 'Okay, bye.', final: true }]);
  });

  it('remembers the words of only the latest few lines', () => {
    const lines = new CallerLines(timers);
    for (let i = 0; i < 20; i += 1) lines.final(`c${i}`, `line ${i}`);
    lines.committed('c0');
    lines.committed('c19');
    expect(lines.sinceAgent()).toEqual([
      { text: '', final: false },
      { text: 'line 19', final: true },
    ]);
  });

  it('settled: at once when every line is final; else when the last final comes, at the time limit, or on close', async () => {
    vi.useFakeTimers();
    const lines = new CallerLines(timers);
    lines.committed('c1');
    lines.final('c1', 'hi');
    await expect(lines.settled(1_500)).resolves.toBeUndefined();

    lines.committed('c2');
    let settled = false;
    void lines.settled(1_500).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    lines.final('c2', 'why not');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    lines.committed('c3');
    let timedOut = false;
    void lines.settled(1_500).then(() => (timedOut = true));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut).toBe(true);

    let closed = false;
    void lines.settled(1_500).then(() => (closed = true));
    lines.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
