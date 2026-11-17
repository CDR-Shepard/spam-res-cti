/**
 * How long the agent waits, once a caller turn is committed, before it answers (gate mode). Replies took a steady
 * 1.3 s, one-word answers included (test calls, 2026-10-28; the owner: "why does it not sound human?"), 0.6 s of it
 * the turn-end silence. A shorter silence (AI_VOICE_SILENCE_MS) answers "Mike" or "Yesterday" sooner; these waits give
 * back the patience it takes away where people do pause: in a long stretch of talk, and after words that trail off
 * ("um", "it's, uh", "... and"). A caller who goes on talking during the wait cancels it (bridge.ts). No patience
 * configured (the default) is no wait: the behaviour before 2026-11-16.
 *
 * The words run behind the turn: at a 250 ms silence the commit comes with none of a one-word line and two or three
 * words short of a sentence, the rest 0.1–0.3 s later, and the final transcript 0.4–0.9 s later, often after the answer
 * has started (probe against the live API, 2026-11-16). So the bridge judges a turn again each time words come in, until
 * the agent is heard, and `trailsOff` must hold up on a line cut short anywhere: it knows thinking sounds and joining
 * words, not "the", "a" or "my", which end a cut-short line all the time ("I have tenants in the | property").
 */

/** Talk since the agent last spoke, this long or longer (ms), is a long turn. */
export const LONG_TURN_MS = 2000;

export interface Patience {
  /** Extra wait before answering a long turn (ms; 0 = none). */
  longTurnWaitMs: number;
  /** Extra wait before answering words that trail off (ms; 0 = none). */
  hesitantWaitMs: number;
}

export const NO_PATIENCE: Patience = { longTurnWaitMs: 0, hesitantWaitMs: 0 };

/** A whole line of thinking sounds. Not "mm-hmm" or "uh-huh": those are a yes. */
const THINKING = /^(?:(?:um+|uh+|uhm+|er+|hm+|well|so|let me think|let's see|i mean|you know)\s*)+$/;
/** "Mm-hmm", "uh-huh": a yes, however it is written. */
const YES_SOUND = /\b(?:m+ hm+|mhm+|uh huh)$/;
/** Words a thought does not end on. Not "so" ("I think so") or "to" ("I'd like to"), and no articles (see above). */
const UNFINISHED: ReadonlySet<string> = new Set(['and', 'but', 'or', 'because', 'um', 'uh', 'uhm', 'ah', 'er', 'hmm']);

/** True when the caller's words so far (all of a line, or a line cut short) are only thinking sounds, or end on a joining word or a thinking sound. */
export function trailsOff(words: string): boolean {
  const said = words
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (said === '' || YES_SOUND.test(said)) return false;
  const last = said.slice(said.lastIndexOf(' ') + 1);
  return THINKING.test(said) || UNFINISHED.has(last);
}

/** The wait before answering a turn: `speechMs` of talk since the agent last spoke, `words` its latest line so far. */
export function answerWaitMs(turn: { speechMs: number; words: string }, patience: Patience): number {
  if (patience.hesitantWaitMs > 0 && trailsOff(turn.words)) return patience.hesitantWaitMs;
  if (patience.longTurnWaitMs > 0 && turn.speechMs >= LONG_TURN_MS) return patience.longTurnWaitMs;
  return 0;
}
