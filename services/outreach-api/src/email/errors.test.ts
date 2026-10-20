import { describe, expect, it } from 'vitest';
import { describeError } from './errors.js';

class BoomError extends Error {
  override name = 'BoomError';
}

describe('describeError', () => {
  it('is the error name, and never the message (a message can carry an address)', () => {
    const out = describeError(new BoomError('could not reach delivered@resend.dev'));
    expect(out).toEqual({ errorName: 'BoomError' });
    expect(JSON.stringify(out)).not.toContain('resend.dev');
  });

  it('adds a string `code` (a Postgres or Node error code) and ignores any other kind', () => {
    expect(describeError(Object.assign(new Error('x'), { code: '23505' }))).toEqual({ errorName: 'Error', errorCode: '23505' });
    expect(describeError(Object.assign(new Error('x'), { code: 42 }))).toEqual({ errorName: 'Error' });
  });

  it('names a thrown non-error by its type, without throwing on null or undefined', () => {
    expect(describeError('a string')).toEqual({ errorName: 'string' });
    expect(describeError(undefined)).toEqual({ errorName: 'undefined' });
    expect(describeError(null)).toEqual({ errorName: 'object' });
  });
});
