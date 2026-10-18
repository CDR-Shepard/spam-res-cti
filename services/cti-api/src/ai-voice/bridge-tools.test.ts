import { describe, expect, it } from 'vitest';
import { followUpAfterTools, type BatchResult, type FunctionCall } from './bridge-tools.js';

const call = (name: string, id = 'c1'): FunctionCall => ({ name, call_id: id, arguments: '{}' });
const SPEAK: BatchResult = { carryOn: true, speak: true };
const QUIET: BatchResult = { carryOn: true, speak: false };
const NOTE = [call('save_qualification')];
const QUESTION = { audio: true, question: true };
const STATEMENT = { audio: true, question: false };
const SILENT = { audio: false, question: false };

describe('followUpAfterTools', () => {
  it('never follows up when the batch chose to stay quiet (wait_for_user)', () => {
    expect(followUpAfterTools([call('wait_for_user')], QUIET, SILENT)).toBe(false);
    expect(followUpAfterTools(NOTE, QUIET, STATEMENT)).toBe(false);
    expect(followUpAfterTools(NOTE, QUIET, QUESTION)).toBe(false);
  });

  it('skips the follow-up for a note save after spoken audio that ended with a question', () => {
    expect(followUpAfterTools(NOTE, SPEAK, QUESTION)).toBe(false);
  });

  it('skips it when several note saves ride on that one question', () => {
    expect(followUpAfterTools([call('save_qualification', 'c1'), call('save_qualification', 'c2')], SPEAK, QUESTION)).toBe(false);
  });

  it('follows up after a note save whose audio ended with a statement', () => {
    expect(followUpAfterTools(NOTE, SPEAK, STATEMENT)).toBe(true);
  });

  it('follows up after a tool-first note save (no audio), even if a stale question flag is set', () => {
    expect(followUpAfterTools(NOTE, SPEAK, SILENT)).toBe(true);
    expect(followUpAfterTools(NOTE, SPEAK, { audio: false, question: true })).toBe(true);
  });

  it('follows up when a note save is mixed with any other tool, question or not', () => {
    expect(followUpAfterTools([call('save_qualification', 'c1'), call('schedule_callback', 'c2')], SPEAK, QUESTION)).toBe(true);
    expect(followUpAfterTools([call('schedule_callback', 'c2'), call('save_qualification', 'c1')], SPEAK, QUESTION)).toBe(true);
  });

  it.each(['schedule_callback', 'book_appointment', 'mark_do_not_call', 'transfer_to_rep', 'end_call'])(
    'follows up after %s alone, even after a question',
    (name) => {
      expect(followUpAfterTools([call(name)], SPEAK, QUESTION)).toBe(true);
    },
  );

  it('follows up after an unknown tool name, even after a question', () => {
    expect(followUpAfterTools([call('write_poem')], SPEAK, QUESTION)).toBe(true);
    expect(followUpAfterTools([call('save_qualification', 'c1'), call('write_poem', 'c2')], SPEAK, QUESTION)).toBe(true);
  });

  it('follows up for an empty batch (nothing to judge)', () => {
    expect(followUpAfterTools([], SPEAK, QUESTION)).toBe(true);
  });
});
