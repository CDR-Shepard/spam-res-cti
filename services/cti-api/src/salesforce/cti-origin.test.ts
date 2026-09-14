import { describe, it, expect } from 'vitest';
import {
  CTI_ORIGIN,
  CTI_ORIGIN_FIELD,
  isInvalidFieldError,
  withoutCtiOrigin,
} from './cti-origin.js';

describe('CTI_ORIGIN values', () => {
  it('fit the 64-character field', () => {
    for (const v of Object.values(CTI_ORIGIN)) {
      expect(v.length).toBeLessThanOrEqual(64);
    }
  });

  // Reports and list views filter on the literal string. Renaming one of these
  // empties them silently, so pin the exact text.
  it('are the exact strings Salesforce reports filter on', () => {
    expect(CTI_ORIGIN.followUp).toBe('Power Dialer Follow-Up');
    expect(CTI_ORIGIN.callLog).toBe('Call Log');
    expect(CTI_ORIGIN_FIELD).toBe('CTI_Origin__c');
  });

  it('are distinct, so a report can tell the two apart', () => {
    const values = Object.values(CTI_ORIGIN);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('isInvalidFieldError', () => {
  it('matches the array body Salesforce actually returns', () => {
    expect(
      isInvalidFieldError([
        { message: "No such column 'CTI_Origin__c' on entity 'Task'.", errorCode: 'INVALID_FIELD' },
      ]),
    ).toBe(true);
  });

  it('matches the INVALID_FIELD_FOR_INSERT_UPDATE variant', () => {
    expect(isInvalidFieldError([{ errorCode: 'INVALID_FIELD_FOR_INSERT_UPDATE' }])).toBe(true);
  });

  it('matches a bare object body, not just an array', () => {
    expect(isInvalidFieldError({ errorCode: 'INVALID_FIELD' })).toBe(true);
  });

  it('finds the code past the first entry', () => {
    expect(
      isInvalidFieldError([{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }, { errorCode: 'INVALID_FIELD' }]),
    ).toBe(true);
  });

  it('does NOT match an unrelated Salesforce error', () => {
    expect(isInvalidFieldError([{ errorCode: 'REQUIRED_FIELD_MISSING' }])).toBe(false);
    expect(isInvalidFieldError([{ errorCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' }])).toBe(
      false,
    );
  });

  it('does NOT match a merely similar-looking message with a different code', () => {
    expect(
      isInvalidFieldError([{ message: 'No such column CTI_Origin__c', errorCode: 'MALFORMED_QUERY' }]),
    ).toBe(false);
  });

  it('tolerates null, undefined and non-object bodies', () => {
    expect(isInvalidFieldError(null)).toBe(false);
    expect(isInvalidFieldError(undefined)).toBe(false);
    expect(isInvalidFieldError('INVALID_FIELD')).toBe(false);
    expect(isInvalidFieldError([])).toBe(false);
    expect(isInvalidFieldError([null])).toBe(false);
  });
});

describe('withoutCtiOrigin', () => {
  it('drops only the marker', () => {
    const out = withoutCtiOrigin({
      Subject: 'Follow up',
      OwnerId: '005X',
      [CTI_ORIGIN_FIELD]: CTI_ORIGIN.followUp,
    });
    expect(out).toEqual({ Subject: 'Follow up', OwnerId: '005X' });
  });

  it('does not mutate the input', () => {
    const input = { Subject: 'Follow up', [CTI_ORIGIN_FIELD]: CTI_ORIGIN.followUp };
    withoutCtiOrigin(input);
    expect(input[CTI_ORIGIN_FIELD]).toBe(CTI_ORIGIN.followUp);
  });

  it('is a no-op when the marker is absent', () => {
    expect(withoutCtiOrigin({ Subject: 'Follow up' })).toEqual({ Subject: 'Follow up' });
  });

  it('keeps falsy values of other fields', () => {
    const out = withoutCtiOrigin({ A: 0, B: '', C: null, [CTI_ORIGIN_FIELD]: 'x' });
    expect(out).toEqual({ A: 0, B: '', C: null });
  });
});
