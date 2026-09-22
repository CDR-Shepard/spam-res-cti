import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { classify, headlineNumber, RecentCallRow, recentSyncLabel, type CallRow } from './RecentCalls';

/** Every column GET /calls hands the client; the overrides describe the case. */
function row(over: Partial<CallRow>): CallRow {
  return {
    id: 'c1',
    toNumber: '+16195550100',
    normalizedToNumber: '+16195550100',
    fromNumber: '+16195550100',
    direction: 'outbound',
    status: 'completed',
    disposition: null,
    notes: null,
    durationSeconds: 0,
    salesforceTaskId: null,
    salesforceWhoId: null,
    salesforceWhatId: null,
    createdAt: new Date().toISOString(),
    syncError: null,
    answeredAt: null,
    inboundVoicemailUrl: null,
    ...over,
  };
}

// The rep's report, verbatim from production: "Just missed an 858 call but
// can't find it." The row WAS at the top of his list — headlined by his own
// DID (+1 619 853-5889) with the outgoing arrow, because the caller reached
// voicemail and hung up after 2 s, which the old rule read as a short
// outbound call.
const MISSED_858: CallRow = row({
  direction: 'inbound',
  status: 'completed',
  durationSeconds: 2,
  fromNumber: '+18583334444',
  normalizedToNumber: '+16198535889',
  toNumber: '+16198535889',
  inboundVoicemailUrl: 'https://x/rec.mp3',
  answeredAt: null,
  disposition: null,
});

describe('recentSyncLabel', () => {
  it('explains a gated call instead of a bare "Local"', () => {
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'not-owner' })).toBe('Not synced · not owner');
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: null })).toBe('Synced');
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: null })).toBe('Local');
  });

  it('says a give-up is a give-up, not "Local"', () => {
    // The sync job exhausted its retries: this call will never reach Salesforce
    // on its own. "Local" reads like "not yet" and left the rep waiting for a
    // Task that is not coming.
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'failed' })).toBe('Not synced · failed');
    // A Task that exists outranks any stale reason on the job.
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: 'failed' })).toBe('Synced');
  });
});

describe('headlineNumber — who the row is about', () => {
  it('an inbound row is headlined by the CALLER, not by our own DID', () => {
    expect(headlineNumber(MISSED_858)).toBe('+1 (858) 333-4444');
  });

  it('an outbound row keeps the dialed number (unchanged)', () => {
    const out = row({ direction: 'outbound', normalizedToNumber: '+18585550123', fromNumber: '+16195550100' });
    expect(headlineNumber(out)).toBe('+1 (858) 555-0123');
  });

  it('a withheld or non-NANP caller reads "Unknown caller", never a raw Twilio token', () => {
    // Twilio's From for a withheld / unroutable caller ID, as seen in production.
    for (const fromNumber of ['anonymous', 'Restricted', '+266696687', '']) {
      expect(headlineNumber(row({ direction: 'inbound', fromNumber })), fromNumber).toBe('Unknown caller');
    }
  });
});

describe('classify — inbound rows', () => {
  it('the production row (reached voicemail, hung up at 2 s) is a voicemail, not an outgoing call', () => {
    expect(classify(MISSED_858)).toBe('voicemail');
  });

  it('answeredAt is the one reliable "the rep picked up" signal → connected', () => {
    const answered = row({
      direction: 'inbound',
      status: 'completed',
      durationSeconds: 500,
      answeredAt: '2026-09-22T10:00:00.000Z',
    });
    expect(classify(answered)).toBe('connected');
  });

  it('answeredAt outranks a voicemail URL (the rep picked up; whatever was recorded is not a missed call)', () => {
    const both = row({
      direction: 'inbound',
      status: 'completed',
      durationSeconds: 40,
      answeredAt: '2026-09-22T10:00:00.000Z',
      inboundVoicemailUrl: 'https://x/rec.mp3',
    });
    expect(classify(both)).toBe('connected');
  });

  it('no_answer / busy / failed / canceled with no voicemail → missed', () => {
    for (const status of ['no_answer', 'busy', 'failed', 'canceled']) {
      expect(classify(row({ direction: 'inbound', status, durationSeconds: 0 })), status).toBe('missed');
    }
  });

  it('a voicemail URL on a no_answer row still reads as voicemail (the caller left one)', () => {
    const vm = row({ direction: 'inbound', status: 'no_answer', inboundVoicemailUrl: 'https://x/rec.mp3' });
    expect(classify(vm)).toBe('voicemail');
  });

  it('legacy completed rows (written before answeredAt existed) fall back to duration: 34 s connected, 3 s missed', () => {
    expect(classify(row({ direction: 'inbound', status: 'completed', durationSeconds: 34 }))).toBe('connected');
    expect(classify(row({ direction: 'inbound', status: 'completed', durationSeconds: 3 }))).toBe('missed');
  });

  it('tolerates an older server that omits answeredAt / inboundVoicemailUrl entirely', () => {
    const legacy: CallRow = row({ direction: 'inbound', status: 'no_answer' });
    delete legacy.answeredAt;
    delete legacy.inboundVoicemailUrl;
    expect(classify(legacy)).toBe('missed');
    const legacyLong: CallRow = row({ direction: 'inbound', status: 'completed', durationSeconds: 60 });
    delete legacyLong.answeredAt;
    delete legacyLong.inboundVoicemailUrl;
    expect(classify(legacyLong)).toBe('connected');
  });
});

describe("classify — outbound rows keep exactly today's rule", () => {
  it('disposition Connected → connected, whatever the duration', () => {
    expect(classify(row({ disposition: 'Connected', durationSeconds: 1 }))).toBe('connected');
  });

  it('duration > 5 → connected even with no disposition yet', () => {
    expect(classify(row({ disposition: null, durationSeconds: 6 }))).toBe('connected');
    expect(classify(row({ disposition: null, durationSeconds: 5 }))).not.toBe('connected');
  });

  it('a Connected disposition wins over a no_answer status (the disposition check runs first)', () => {
    expect(classify(row({ disposition: 'Connected', status: 'no_answer', durationSeconds: 0 }))).toBe('connected');
  });

  it('no_answer / busy / failed → missed', () => {
    for (const status of ['no_answer', 'busy', 'failed']) {
      expect(classify(row({ status, durationSeconds: 0 })), status).toBe('missed');
    }
  });

  it('everything else (short completed, canceled, in_progress) → outgoing', () => {
    expect(classify(row({ status: 'completed', durationSeconds: 3 }))).toBe('outgoing');
    expect(classify(row({ status: 'canceled', durationSeconds: 0 }))).toBe('outgoing');
    expect(classify(row({ status: 'in_progress', durationSeconds: null }))).toBe('outgoing');
  });

  it('inbound-only signals are ignored on an outbound row', () => {
    // An outbound row never carries these, but if one did, the outbound rule
    // must not start reading them.
    const odd = row({ status: 'completed', durationSeconds: 2, inboundVoicemailUrl: 'https://x/rec.mp3' });
    expect(classify(odd)).toBe('outgoing');
  });
});

describe('RecentCallRow — the rendered row', () => {
  it("the production row shows the 858 caller, never the rep's own DID, and reads Voicemail", () => {
    const html = renderToStaticMarkup(<RecentCallRow call={MISSED_858} />);
    expect(html).toContain('+1 (858) 333-4444');
    expect(html).not.toContain('853-5889');
    expect(html).toContain('Voicemail');
    expect(html).toContain('row-item voicemail');
  });

  it('inbound subtitles: Answered / Missed call', () => {
    const answered = row({ direction: 'inbound', status: 'completed', durationSeconds: 90, answeredAt: '2026-09-22T10:00:00.000Z' });
    expect(renderToStaticMarkup(<RecentCallRow call={answered} />)).toContain('Answered');
    const missed = row({ direction: 'inbound', status: 'no_answer', durationSeconds: 0 });
    expect(renderToStaticMarkup(<RecentCallRow call={missed} />)).toContain('Missed call');
  });

  it('an unknown inbound caller is headlined "Unknown caller"', () => {
    const html = renderToStaticMarkup(<RecentCallRow call={row({ direction: 'inbound', status: 'no_answer', fromNumber: 'anonymous' })} />);
    expect(html).toContain('Unknown caller');
  });

  it('outbound rows keep disposition ?? status as the subtitle and the dialed number as the headline', () => {
    const out = row({ direction: 'outbound', normalizedToNumber: '+18585550123', status: 'no_answer', durationSeconds: 0 });
    const html = renderToStaticMarkup(<RecentCallRow call={out} />);
    expect(html).toContain('+1 (858) 555-0123');
    expect(html).toContain('no answer');
    expect(html).not.toContain('Missed call');
    const dispositioned = renderToStaticMarkup(<RecentCallRow call={row({ ...out, disposition: 'Left VM' })} />);
    expect(dispositioned).toContain('Left VM');
  });
});
