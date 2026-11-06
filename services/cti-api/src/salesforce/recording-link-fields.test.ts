import { describe, expect, it, vi } from 'vitest';
import { CALL_RECORDING_FIELD, PACKAGE_RECORDING_FIELD, writeRecordingLink } from './recording-link-fields.js';

const URL = 'https://cti.example/recordings/call-1?sig=abc';
type Fields = Record<string, string>;

describe('writeRecordingLink — the recording link on a Task, for every rep', () => {
  it('names the two fields the org has (the Task layout and reports read these names)', () => {
    expect(CALL_RECORDING_FIELD).toBe('CTI_Recording_Link__c');
    expect(PACKAGE_RECORDING_FIELD).toBe('tdc_cti__Recording_URL__c');
  });

  it('writes our field first, then the package field, as two separate PATCHes', async () => {
    const update = vi.fn(async () => ({ updated: true }));
    expect(await writeRecordingLink(update, 'rep-1', '00T1', URL)).toEqual({ callRecording: true, packageField: true });
    expect(update.mock.calls).toEqual([
      ['rep-1', '00T1', { CTI_Recording_Link__c: URL }],
      ['rep-1', '00T1', { tdc_cti__Recording_URL__c: URL }],
    ]);
  });

  it('a rep without the 360 CTI license still gets the link in our field', async () => {
    const update = vi.fn(async (_u: string, _t: string, f: Fields) => ({ updated: !(PACKAGE_RECORDING_FIELD in f) }));
    expect(await writeRecordingLink(update, 'rep-1', '00T1', URL)).toEqual({ callRecording: true, packageField: false });
  });

  it('our field rejected still tries the package field', async () => {
    const update = vi.fn(async (_u: string, _t: string, f: Fields) => ({ updated: !(CALL_RECORDING_FIELD in f) }));
    expect(await writeRecordingLink(update, 'rep-1', '00T1', URL)).toEqual({ callRecording: false, packageField: true });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('a failed PATCH throws to the caller, which owns the retry', async () => {
    const update = vi.fn(async () => {
      throw new Error('503');
    });
    await expect(writeRecordingLink(update, 'rep-1', '00T1', URL)).rejects.toThrow('503');
  });

  it('our PATCH failing still writes the package field, then throws so the caller retries', async () => {
    const update = vi.fn(async (_u: string, _t: string, f: Fields) => {
      if (CALL_RECORDING_FIELD in f) throw new Error('validation rule');
      return { updated: true };
    });
    await expect(writeRecordingLink(update, 'rep-1', '00T1', URL)).rejects.toThrow('validation rule');
    expect(update).toHaveBeenNthCalledWith(2, 'rep-1', '00T1', { [PACKAGE_RECORDING_FIELD]: URL });
  });

  it('the package PATCH failing after ours landed is not swallowed: the caller retries both', async () => {
    const update = vi.fn(async (_u: string, _t: string, f: Fields) => {
      if (PACKAGE_RECORDING_FIELD in f) throw new Error('503');
      return { updated: true };
    });
    await expect(writeRecordingLink(update, 'rep-1', '00T1', URL)).rejects.toThrow('503');
  });
});
