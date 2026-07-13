import { describe, expect, it } from 'vitest';
import { buildQueueRows } from './create-session.js';

describe('buildQueueRows', () => {
  it('numbers rows and marks unreachable when no number resolved', () => {
    const rows = buildQueueRows('S1', 'Lead', [
      { recordId: '00Q1', toNumber: '+16195550100' },
      { recordId: '00Q2', toNumber: null },
    ]);
    expect(rows).toEqual([
      { sessionId: 'S1', ordinal: 0, objectType: 'Lead', recordId: '00Q1', toNumber: '+16195550100', status: 'pending' },
      { sessionId: 'S1', ordinal: 1, objectType: 'Lead', recordId: '00Q2', toNumber: null, status: 'unreachable' },
    ]);
  });
});
