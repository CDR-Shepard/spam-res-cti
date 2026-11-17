import { describe, expect, it } from 'vitest';
import { LONG_TURN_MS, NO_PATIENCE, answerWaitMs, trailsOff } from './turn-patience.js';

const PATIENCE = { longTurnWaitMs: 250, hesitantWaitMs: 700 };

describe('trailsOff', () => {
  it.each(['Um.', ' Um,', 'Uh,', 'Hmm.', 'Well...', 'So, um', "It's, uh", ' Its, ah', 'I want to see if I can get an offer on and', 'We could do Tuesday or.', 'I was going to sell it but', 'Let me think.'])(
    '"%s" trails off',
    (words) => {
      expect(trailsOff(words)).toBe(true);
    },
  );

  // "Mm-hmm" and "uh-huh" are a yes, and "I think so" is a whole answer: none of them waits.
  it.each(['Mike.', 'Yesterday.', 'Mm-hmm.', 'Uh-huh.', 'Yeah.', 'I think so.', 'Costa Mesa.', "It's paid off.", 'Like what kind of updates?', ''])('"%s" does not', (words) => {
    expect(trailsOff(words)).toBe(false);
  });

  // The words run behind the turn, so a whole sentence is first seen cut short. A cut after "the", "a", "my" or "if"
  // is the usual case ("I have tenants in the | property"), not a caller trailing off: it must not wait.
  it.each([' Yeah, I have tenants in the', ' I want to sell the', ' It is a', ' I talked to my', ' I want to', ' No, it', ' Costa', ' I am not sure if'])(
    'a line cut short at "%s" does not',
    (words) => {
      expect(trailsOff(words)).toBe(false);
    },
  );
});

describe('answerWaitMs', () => {
  it('a short answer is answered at once', () => {
    expect(answerWaitMs({ speechMs: 400, words: 'Mike.' }, PATIENCE)).toBe(0);
    expect(answerWaitMs({ speechMs: LONG_TURN_MS - 1, words: '' }, PATIENCE)).toBe(0);
  });

  it('a long stretch of talk gets the long-turn wait: they may only be pausing', () => {
    expect(answerWaitMs({ speechMs: LONG_TURN_MS, words: 'the roof is pretty old though.' }, PATIENCE)).toBe(250);
  });

  it('words that trail off get the hesitant wait, long turn or not', () => {
    expect(answerWaitMs({ speechMs: 300, words: 'Um.' }, PATIENCE)).toBe(700);
    expect(answerWaitMs({ speechMs: 5000, words: 'I want to see if I can get an offer on and, uh,' }, PATIENCE)).toBe(700);
  });

  it('no patience configured: never a wait (the default)', () => {
    expect(answerWaitMs({ speechMs: 9000, words: 'Um.' }, NO_PATIENCE)).toBe(0);
    expect(answerWaitMs({ speechMs: 9000, words: 'Um.' }, { longTurnWaitMs: 250, hesitantWaitMs: 0 })).toBe(250);
  });
});
