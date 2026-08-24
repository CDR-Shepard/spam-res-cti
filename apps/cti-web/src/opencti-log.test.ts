import { describe, expect, it } from 'vitest';
import { openCtiSavePlan } from './opencti-log';

const base = { recordId: '00Q000000000001', taskAllowed: true, alreadyWritten: false, existingTaskId: null };

describe('openCtiSavePlan', () => {
  it('writes a new Task on the first submit of a click-to-dial call', () => {
    expect(openCtiSavePlan(base)).toEqual({ write: true });
  });

  it('never writes without a click-to-dial record', () => {
    // No recordId → the BACKEND logs the call (SOSL/persisted record), so an
    // Open CTI write here would be a second Task.
    expect(openCtiSavePlan({ ...base, recordId: undefined })).toEqual({ write: false });
  });

  it('never writes when the server ownership gate said no', () => {
    expect(openCtiSavePlan({ ...base, taskAllowed: false })).toEqual({ write: false });
  });

  it('UPDATES the existing Task on retry when Salesforce told us its id', () => {
    // The rep changed the disposition and resubmitted: Subject and
    // CallDisposition both moved, so the Task has to be rewritten, not left
    // carrying the first attempt's values.
    expect(openCtiSavePlan({ ...base, alreadyWritten: true, existingTaskId: '00T000000000001' }))
      .toEqual({ write: true, updateId: '00T000000000001' });
  });

  it('does NOT re-write on retry when the Task id is unknown — a second saveLog would duplicate it', () => {
    expect(openCtiSavePlan({ ...base, alreadyWritten: true, existingTaskId: null })).toEqual({ write: false });
  });

  it('keeps the id out of a first write even if one is somehow stashed', () => {
    // Defensive: an id without a prior successful write is not an update.
    expect(openCtiSavePlan({ ...base, existingTaskId: '00T000000000001' })).toEqual({ write: true });
  });
});
