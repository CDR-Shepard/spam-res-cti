/**
 * Is the caller's speech over the agent a listening sound ("mm-hmm", "yeah", "okay") or a real
 * interruption? Used by the overlap gate (bridge-overlap.ts) on the words `gpt-live-transcribe`
 * streams while the caller is still talking.
 * Spec: docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1.
 */
export type OverlapVerdict = 'empty' | 'listening' | 'interrupt';

/** This many words that are not listening sounds = they are saying something. */
export const INTERRUPT_WORD_COUNT = 2;

/** Multi-word listening sounds, folded into one token before splitting (order matters). */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bo\.?\s*k\b\.?/g, 'ok'],
  [/\bu+h+[\s-]*h+u+h+\b/g, 'uhhuh'],
  [/\bm+[\s-]*h+m+\b/g, 'mmhmm'],
  [/\bi see\b/g, 'isee'],
  [/\bgot it\b/g, 'gotit'],
  [/\ball right\b/g, 'alright'],
  [/\bmakes sense\b/g, 'makessense'],
  [/\bfor sure\b/g, 'forsure'],
];

/** "I'm listening", not "my turn" — never stop the agent on these alone. */
const LISTENING: ReadonlySet<string> = new Set([
  'mmhmm', 'uhhuh', 'hmm', 'mm', 'um', 'uh', 'yeah', 'yea', 'ya', 'yep', 'yup', 'yes', 'ok', 'okay',
  'right', 'sure', 'alright', 'gotit', 'gotcha', 'isee', 'oh', 'ah', 'wow', 'cool', 'nice', 'great',
  'true', 'totally', 'exactly', 'really', 'interesting', 'makessense', 'forsure', 'hello',
]);

/** Stretched or doubled fillers: mmm, hm, hmmm, umm, uhh, uhm, ohh, ahh, eh, ehh, erm. */
const FILLER = /^(?:m+|h+m+|u+h+|u+h+m+|u+m+|a+h+|o+h+|e+h+|e+r+m*)$/;
const isListening = (w: string): boolean => LISTENING.has(w) || FILLER.test(w);

/** One of these is enough to stop the agent ("hold" on/up, "hang" on). */
const STOP: ReadonlySet<string> = new Set([
  'wait', 'hold', 'hang', 'stop', 'no', 'nope', 'nah', 'who', 'why', 'sorry', 'excuse', 'what', 'huh', 'pardon', 'actually', 'but',
]);

/** Lower-case word tokens, with listening phrases folded into one token each. */
export function words(text: string): string[] {
  const folded = PHRASES.reduce(
    (t, [re, token]) => t.replace(re, token),
    text.toLowerCase().replace(/['’]/g, '').replace(/[‐-―−]/g, '-'),
  );
  return folded.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
}

/**
 * `hello` alone is a listening sound (a "Hello?" over the agent's opener is the greeting), but a
 * repeated "Hello? Hello?" means "can you hear me?" — an interruption.
 */
export function overlapVerdict(text: string): OverlapVerdict {
  const ws = words(text);
  if (ws.length === 0) return 'empty';
  if (ws.some((w) => STOP.has(w))) return 'interrupt';
  const talking = ws.filter((w) => !isListening(w)).length;
  const hellos = ws.filter((w) => w === 'hello').length;
  return talking >= INTERRUPT_WORD_COUNT || hellos >= 2 ? 'interrupt' : 'listening';
}
