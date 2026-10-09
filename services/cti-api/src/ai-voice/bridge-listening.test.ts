import { describe, expect, it } from 'vitest';
import { overlapVerdict, words } from './bridge-listening.js';

describe('words', () => {
  it('folds listening phrases into one token and drops punctuation and apostrophes', () => {
    expect(words('Mm-hmm.')).toEqual(['mmhmm']);
    expect(words('mm hmm')).toEqual(['mmhmm']);
    expect(words('Mhm')).toEqual(['mmhmm']);
    expect(words('Uh-huh, uh huh')).toEqual(['uhhuh', 'uhhuh']);
    expect(words('Uh–huh')).toEqual(['uhhuh']);
    expect(words('O.K.')).toEqual(['ok']);
    expect(words('I see. Got it! All right')).toEqual(['isee', 'gotit', 'alright']);
    expect(words("I've been thinking")).toEqual(['ive', 'been', 'thinking']);
    expect(words('  ')).toEqual([]);
  });
});

describe('overlapVerdict', () => {
  it.each([
    ['', 'empty'],
    ['...', 'empty'],
    ['Mm-hmm.', 'listening'],
    ['Uh-huh', 'listening'],
    ['Yeah.', 'listening'],
    ['Yeah, sure.', 'listening'],
    ['Okay okay', 'listening'],
    ['Oh wow, really?', 'listening'],
    ['Right, I see.', 'listening'],
    ['Hmm', 'listening'],
    ['Um', 'listening'],
    ['Hello?', 'listening'],
    ['Wait', 'interrupt'],
    ['Hold on', 'interrupt'],
    ['Hang on a sec', 'interrupt'],
    ['No', 'interrupt'],
    ['Sorry?', 'interrupt'],
    ['Huh?', 'interrupt'],
    ['What?', 'interrupt'],
    ['Yeah but', 'interrupt'],
    ['Actually', 'interrupt'],
    ["I'm interested", 'interrupt'],
    ['Who is this', 'interrupt'],
    ['Hello? Hello?', 'interrupt'],
    ['Yeah, the roof', 'interrupt'],
    ['Interested', 'listening'],
    ['Thanks', 'listening'],
    ['Uh–huh', 'listening'],
    ['Uh‑huh', 'listening'],
    ['Mm—hmm', 'listening'],
    ['Mmm, mmm', 'listening'],
    ['Hm hm', 'listening'],
    ['Umm, uhh', 'listening'],
    ['Ohh, ahh', 'listening'],
    ['Erm', 'listening'],
    ['O.K.', 'listening'],
    ['Gotcha', 'listening'],
    ['Nope', 'interrupt'],
    ['Nah', 'interrupt'],
    ['Who?', 'interrupt'],
    ['Why?', 'interrupt'],
    ['Stop', 'interrupt'],
    ['Pardon?', 'interrupt'],
    ['Excuse me', 'interrupt'],
    ['I’m interested', 'interrupt'],
  ] as const)('%j → %s', (text, verdict) => {
    expect(overlapVerdict(text)).toBe(verdict);
  });
});
