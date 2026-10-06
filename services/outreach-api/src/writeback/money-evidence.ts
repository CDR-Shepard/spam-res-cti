/**
 * Plan 1D write-back (5a Fix 1, I-2): does the seller's quoted evidence justify a money value? The user's rule is that
 * the AI never writes an amount the seller did not state, so the value must follow from the quote itself:
 *
 * - **Digits:** when the quote has any digit, only the digits count. Each number n (commas and "$" ignored) gives n, or
 *   n × 1,000 with k / thousand / grand, or n × 1,000,000 with m / mil / million right after it.
 * - **Words only:** a run of number words counts only with a magnitude (hundred, thousand, grand, million, mil), and only
 *   when it parses with no ambiguity ("two fifty thousand", "a quarter million", "three hundred grand"). Anything else
 *   gives nothing, so the value is dropped.
 *
 * Pure.
 */

const DIGIT_NUMBER = /(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|grand|mil|k|m)?(?![a-z])/g;
const SCALE: Readonly<Record<string, number>> = { k: 1_000, thousand: 1_000, grand: 1_000, m: 1_000_000, mil: 1_000_000, million: 1_000_000 };

const UNITS: Readonly<Record<string, number>> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TEENS: Readonly<Record<string, number>> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG: Readonly<Record<string, number>> = { thousand: 1_000, grand: 1_000, million: 1_000_000, mil: 1_000_000 };
const FRACTION: Readonly<Record<string, number>> = { quarter: 0.25, half: 0.5 };
/** Words that may sit inside a spoken amount. "a" and "and" only join; they never start or end one. */
const NUMBER_WORD = new Set([...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(TENS), ...Object.keys(BIG), ...Object.keys(FRACTION), 'hundred', 'point', 'a', 'and']);
const MAGNITUDE = new Set(['hundred', ...Object.keys(BIG)]);

/** "a" joins only before a magnitude or a fraction ("a million", "a quarter million"). */
const aJoins = (next: string | undefined): boolean => next !== undefined && (MAGNITUDE.has(next) || next in FRACTION);

const lower = (s: string): string => s.replace(/&amp;/g, '&').toLowerCase();

function digitCandidates(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(/\$/g, '').matchAll(DIGIT_NUMBER)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    out.push(Math.round(n * (m[2] === undefined ? 1 : SCALE[m[2]]!)));
  }
  return out;
}

/** The kind of the last token read, for the colloquial "two fifty" (= 250) and the ambiguity checks. */
type Last = 'start' | 'unit' | 'teen' | 'tens' | 'hundred' | 'big' | 'fraction' | 'join' | 'point';

/** One run of number words → its value, or null when it is ambiguous or malformed. */
function parseRun(tokens: readonly string[]): number | null {
  let total = 0;
  let current = 0;
  let last: Last = 'start';
  let lastBig = Infinity;
  let aPending = false;
  let decimals: number | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (decimals !== null && !(t in BIG)) {
      if (!(t in UNITS)) return null;
      decimals += 1;
      current += UNITS[t]! / 10 ** decimals;
      last = 'point';
      continue;
    }
    if (t === 'a') {
      if (!aJoins(tokens[i + 1])) return null;
      aPending = true;
      last = 'join';
    } else if (t === 'and') {
      last = 'join';
    } else if (t in UNITS) {
      if (last === 'unit' || last === 'teen') return null;
      if (last === 'tens' && current % 10 !== 0) return null;
      current += UNITS[t]!;
      last = 'unit';
    } else if (t in TEENS || t in TENS) {
      const v = (TEENS[t] ?? TENS[t])!;
      const colloquial = (last === 'unit' || last === 'teen') && current > 0 && current < 20;
      if (colloquial) current = current * 100 + v;
      else if (last === 'tens' || last === 'unit' || last === 'teen') return null;
      else current += v;
      last = t in TEENS ? 'teen' : 'tens';
    } else if (t === 'hundred') {
      if (current === 0 && !aPending) return null;
      if (current >= 100) return null;
      current = (current === 0 ? 1 : current) * 100;
      aPending = false;
      last = 'hundred';
    } else if (t in FRACTION) {
      current += FRACTION[t]!;
      aPending = false;
      last = 'fraction';
    } else if (t === 'point') {
      if (last !== 'unit' && last !== 'teen' && last !== 'tens') return null;
      decimals = 0;
      last = 'point';
    } else if (t in BIG) {
      const scale = BIG[t]!;
      if (current === 0 && !aPending) return null;
      if (scale >= lastBig) return null;
      total += (current === 0 ? 1 : current) * scale;
      current = 0;
      decimals = null;
      aPending = false;
      lastBig = scale;
      last = 'big';
    } else {
      return null;
    }
  }
  if (last === 'join' || last === 'point' || aPending) return null;
  return Math.round(total + current);
}

/** Maximal runs of number words, with joining words trimmed from both ends. */
function wordRuns(text: string): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  const flush = () => {
    while (run.length > 0 && (run[0] === 'and' || (run[0] === 'a' && !aJoins(run[1])))) run.shift();
    while (run.length > 0 && (run[run.length - 1] === 'a' || run[run.length - 1] === 'and')) run.pop();
    if (run.length > 0) runs.push(run);
    run = [];
  };
  for (const w of text.split(/[^a-z]+/)) {
    if (NUMBER_WORD.has(w)) run.push(w);
    else flush();
  }
  flush();
  return runs;
}

function wordCandidates(text: string): number[] {
  const out: number[] = [];
  for (const run of wordRuns(text)) {
    if (!run.some((w) => MAGNITUDE.has(w))) continue;
    const v = parseRun(run);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Every amount the quote states, in order. Digits win: a quote with any digit is read from its digits only. */
export function moneyCandidates(evidence: string): number[] {
  const text = lower(evidence);
  return /\d/.test(text) ? digitCandidates(text) : wordCandidates(text);
}

/** Whether the seller's quote states exactly this amount. */
export function evidenceJustifies(evidence: string, value: number): boolean {
  return moneyCandidates(evidence).includes(value);
}
