import { describe, expect, it } from 'vitest';
import { AiCallBookingSettings, BookingRouting } from '@cti/contracts';
import {
  bookingActive,
  bookingRouting,
  bookingSettings,
  DEFAULT_AI_CALL_BOOKING,
  DEFAULT_AI_CALL_CONCURRENCY,
  DEFAULT_AI_CALL_DAILY_CAP,
  DEFAULT_AI_CALL_MAX_ATTEMPTS,
  DEFAULT_BOOKING_ROUTING,
  liveCallBooking,
  outreachSettings,
  practiceBooking,
  samEmailSettings,
  type OutreachSettings,
} from './settings.js';

// Final review WEB I-2: booking and Lead conversion are off until an admin turns them on (after the readiness check, a
// practice call and the one-Lead check), whatever AI_CALL_DEFAULT_SPECIALISTS says.
const DEFAULT_BOOKING: AiCallBookingSettings = {
    enabled: false,
    specialists: [],
    convertLeads: false,
    days: [1, 2, 3, 4, 5],
    phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
    walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
};

// A blob without `routing` (or no blob at all) is read with the routing defaults filled in.
const DEFAULT_ROUTED: AiCallBookingSettings = { ...DEFAULT_BOOKING, routing: DEFAULT_BOOKING_ROUTING };

const DEFAULTS: OutreachSettings = {
  aiDailyBudgetUsd: 25,
  liveChannels: ['rep_call'],
  consentFromWebForms: false,
  consentFromInboundCalls: false,
  aiCallConcurrency: 2,
  aiCallDailyCap: 50,
  aiCallMaxAttempts: 3,
  aiCallWriteback: false,
};
const GRANT = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';
const CHANCE = '0055f000005qXn8AAE';
const BLAKE = '0058X00000FA8tLQAT';
const SETH = '0055f000005qXVfAAM';
const THOMAS = '0055f000005qYO6AAM';

describe('outreachSettings', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'oops'],
    ['an array', ['rep_call']],
    ['a number', 42],
  ])('returns the defaults for %s', (_label, settings) => {
    expect(outreachSettings({ settings })).toEqual(DEFAULTS);
  });

  it('reads every valid key', () => {
    const settings = { aiDailyBudgetUsd: 40.5, liveChannels: ['rep_call', 'sms'], consentFromWebForms: true, consentFromInboundCalls: true, smsMode: 'x' };
    expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, aiDailyBudgetUsd: 40.5, liveChannels: ['rep_call'], consentFromWebForms: true, consentFromInboundCalls: true });
  });

  it.each([
    ['a negative budget', { aiDailyBudgetUsd: -1 }, { aiDailyBudgetUsd: 25 }],
    ['a string budget', { aiDailyBudgetUsd: '30' }, { aiDailyBudgetUsd: 25 }],
    ['an infinite budget', { aiDailyBudgetUsd: Number.POSITIVE_INFINITY }, { aiDailyBudgetUsd: 25 }],
    ['a zero budget (AI off)', { aiDailyBudgetUsd: 0 }, { aiDailyBudgetUsd: 0 }],
    ['liveChannels that is not an array', { liveChannels: 'sms' }, { liveChannels: ['rep_call'] }],
    ['unknown and duplicate channels', { liveChannels: ['SMS', 'rep_call', 7, 'rep_call', 'fax'] }, { liveChannels: ['rep_call'] }],
    ['channels that are not implemented yet (phase 1: only rep_call is live)', { liveChannels: ['rep_call', 'ai_call', 'sms', 'email'] }, { liveChannels: ['rep_call'] }],
    ['only not-yet-implemented channels', { liveChannels: ['sms', 'email', 'ai_call'] }, { liveChannels: [] }],
    ['an empty channel list (everything off)', { liveChannels: [] }, { liveChannels: [] }],
    ['string booleans', { consentFromWebForms: 'true', consentFromInboundCalls: 1 }, { consentFromWebForms: false, consentFromInboundCalls: false }],
  ])('tolerates %s', (_label, settings, expected) => {
    expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, ...expected });
  });

  it('returns a fresh liveChannels array each call', () => {
    const a = outreachSettings({ settings: {} });
    a.liveChannels.push('sms');
    expect(outreachSettings({ settings: {} }).liveChannels).toEqual(['rep_call']);
  });

  describe('AI call pacing settings', () => {
    it('defaults to 2 live calls, 50 a day and 3 attempts', () => {
      const s = outreachSettings({ settings: {} });
      expect([s.aiCallConcurrency, s.aiCallDailyCap, s.aiCallMaxAttempts]).toEqual([2, 50, 3]);
      expect([DEFAULT_AI_CALL_CONCURRENCY, DEFAULT_AI_CALL_DAILY_CAP, DEFAULT_AI_CALL_MAX_ATTEMPTS]).toEqual([2, 50, 3]);
    });

    it.each([
      ['concurrency 3', { aiCallConcurrency: 3 }, { aiCallConcurrency: 3 }],
      ['concurrency 1 (lowest)', { aiCallConcurrency: 1 }, { aiCallConcurrency: 1 }],
      ['concurrency 5 (highest)', { aiCallConcurrency: 5 }, { aiCallConcurrency: 5 }],
      ['a daily cap of 0 (AI calls off)', { aiCallDailyCap: 0 }, { aiCallDailyCap: 0 }],
      ['a daily cap of 500 (highest)', { aiCallDailyCap: 500 }, { aiCallDailyCap: 500 }],
      ['5 attempts', { aiCallMaxAttempts: 5 }, { aiCallMaxAttempts: 5 }],
      ['1 attempt', { aiCallMaxAttempts: 1 }, { aiCallMaxAttempts: 1 }],
    ])('keeps %s', (_label, settings, expected) => {
      expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, ...expected });
    });

    it.each([
      ['concurrency 6', { aiCallConcurrency: 6 }],
      ['concurrency 0', { aiCallConcurrency: 0 }],
      ['a daily cap of -1', { aiCallDailyCap: -1 }],
      ['a daily cap of 501', { aiCallDailyCap: 501 }],
      ['attempts 6', { aiCallMaxAttempts: 6 }],
      ['attempts 0', { aiCallMaxAttempts: 0 }],
      ['a fraction', { aiCallConcurrency: 2.5, aiCallDailyCap: 2.5, aiCallMaxAttempts: 2.5 }],
      ['strings', { aiCallConcurrency: '3', aiCallDailyCap: '3', aiCallMaxAttempts: '3' }],
      ['NaN and Infinity', { aiCallConcurrency: Number.NaN, aiCallDailyCap: Number.POSITIVE_INFINITY, aiCallMaxAttempts: null }],
    ])('falls back to the defaults for %s', (_label, settings) => {
      expect(outreachSettings({ settings })).toEqual(DEFAULTS);
    });
  });

  describe('AI call booking and write-back settings (plan 1D)', () => {
    it('DEFAULT_AI_CALL_BOOKING is the plan\'s defaults and parses with the contract', () => {
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULT_BOOKING);
      expect(AiCallBookingSettings.safeParse(DEFAULT_AI_CALL_BOOKING).success).toBe(true);
    });

    it('final review WEB I-2: an empty blob gives the defaults: booking, conversion and write-back all off', () => {
      expect(bookingSettings({ settings: {} }, [])).toEqual(DEFAULT_ROUTED);
      expect(outreachSettings({ settings: {} }).aiCallWriteback).toBe(false);
    });

    it('final review WEB I-2: a configured default owner fills the list but turns nothing on', () => {
      const b = bookingSettings({ settings: {} }, [GRANT]);
      expect(b).toMatchObject({ enabled: false, convertLeads: false, specialists: [GRANT] });
      expect(bookingActive(b)).toBe(false);
    });

    it('Fix 1 (M-4): booking is read only through bookingSettings, whose default list is required', () => {
      expect('aiCallBooking' in outreachSettings({ settings: { aiCallBooking: DEFAULT_BOOKING } })).toBe(false);
      // Type-level: a reader cannot forget the configured default list (never called).
      const forgot = () => {
        // @ts-expect-error defaultSpecialists is required
        bookingSettings({ settings: {} });
      };
      expect(forgot).toBeTypeOf('function');
    });

    it.each([
      ['a non-boolean switch', { enabled: 'yes' }],
      ['a partial blob', { enabled: false }],
      ['a bad user id', { ...DEFAULT_BOOKING, specialists: ['abc'] }],
      ['an end hour before the start hour', { ...DEFAULT_BOOKING, phone: { ...DEFAULT_BOOKING.phone, startHour: 12, endHour: 11 } }],
      ['an unknown key', { ...DEFAULT_BOOKING, rotate: true }],
      ['a string', 'on'],
      ['null', null],
    ])('%s falls back to the default as a whole (never half-applied)', (_label, aiCallBooking) => {
      expect(bookingSettings({ settings: { aiCallBooking } }, [])).toEqual(DEFAULT_ROUTED);
    });

    it('the malformed fallback still takes the configured default list', () => {
      expect(bookingSettings({ settings: { aiCallBooking: { enabled: 'yes' } } }, [GRANT]).specialists).toEqual([GRANT]);
    });

    it('the configured default list is used when the tenant never saved one', () => {
      expect(bookingSettings({ settings: {} }, [GRANT])).toEqual({ ...DEFAULT_ROUTED, specialists: [GRANT] });
    });

    it('a saved list always wins over the configured default, even an empty one', () => {
      const saved = { ...DEFAULT_BOOKING, specialists: [] };
      expect(bookingSettings({ settings: { aiCallBooking: saved } }, [GRANT]).specialists).toEqual([]);
      const other = { ...DEFAULT_BOOKING, specialists: [OTHER, GRANT] };
      expect(bookingSettings({ settings: { aiCallBooking: other } }, [GRANT]).specialists).toEqual([OTHER, GRANT]);
    });

    it('a valid custom blob is kept', () => {
      const custom = {
        enabled: false,
        specialists: [OTHER],
        convertLeads: false,
        days: [1, 3, 5, 6],
        phone: { ...DEFAULT_BOOKING.phone, durationMinutes: 20, stepMinutes: 15, maxOffered: 4 },
        walkthrough: { ...DEFAULT_BOOKING.walkthrough, enabled: false, startHour: 8, endHour: 12 },
      };
      expect(bookingSettings({ settings: { aiCallBooking: custom } }, [GRANT])).toEqual({ ...custom, routing: DEFAULT_BOOKING_ROUTING });
    });

    it('a blob saved before routing existed still parses: booking stays on and the routing defaults apply', () => {
      const saved = { ...DEFAULT_BOOKING, enabled: true, specialists: [GRANT], convertLeads: true };
      expect('routing' in saved).toBe(false);
      const b = bookingSettings({ settings: { aiCallBooking: saved } }, []);
      expect(b).toEqual({ ...saved, routing: DEFAULT_BOOKING_ROUTING });
      expect(b.enabled).toBe(true);
      expect(b.routing).toEqual(DEFAULT_BOOKING_ROUTING);
      expect(bookingActive(b)).toBe(true);
    });

    it('a blob saved with its own routing keeps it', () => {
      const own: BookingRouting = { ...DEFAULT_BOOKING_ROUTING, regions: [{ ...DEFAULT_BOOKING_ROUTING.regions[0]!, reps: [OTHER] }, DEFAULT_BOOKING_ROUTING.regions[1]!] };
      const saved = { ...DEFAULT_BOOKING, enabled: true, specialists: [GRANT], routing: own };
      expect(bookingSettings({ settings: { aiCallBooking: saved } }, []).routing).toEqual(own);
    });

    it('returns fresh objects: changing one result never changes the defaults or the next result', () => {
      const a = bookingSettings({ settings: {} }, [GRANT]);
      a.specialists.push(OTHER);
      a.phone.durationMinutes = 99;
      a.days.push(6);
      a.routing!.regions[0]!.reps.push(OTHER);
      a.routing!.regions[1]!.counties.push('Imperial');
      const savedWithoutRouting = bookingSettings({ settings: { aiCallBooking: DEFAULT_BOOKING } }, []);
      savedWithoutRouting.routing!.regions.pop();
      const b = bookingSettings({ settings: {} }, [GRANT]);
      expect(b).toEqual({ ...DEFAULT_ROUTED, specialists: [GRANT] });
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULT_BOOKING);
      expect(DEFAULT_BOOKING_ROUTING.regions).toHaveLength(2);
      expect(DEFAULT_BOOKING_ROUTING.regions[0]!.reps).toEqual([CHANCE, BLAKE]);
    });

    it.each([
      ['false', false, false],
      ['true', true, true],
      ['the string "true"', 'true', false],
      ['1', 1, false],
      ['null', null, false],
      ['absent', undefined, false],
    ])('aiCallWriteback %s gives %s (off unless explicitly true, final review WEB I-2)', (_label, aiCallWriteback, expected) => {
      expect(outreachSettings({ settings: { aiCallWriteback } }).aiCallWriteback).toBe(expected);
    });

    describe('fix 2: booking needs write-back for a real call; a practice call offers times whenever there is a specialist', () => {
      const saved = (enabled: boolean, specialists: string[]) => ({ aiCallBooking: { ...DEFAULT_BOOKING, enabled, specialists } });

      it.each([
        ['booking on, write-back on', { ...saved(true, [GRANT]), aiCallWriteback: true }, true],
        ['booking on, write-back off', { ...saved(true, [GRANT]), aiCallWriteback: false }, false],
        ['booking on, write-back absent', saved(true, [GRANT]), false],
        ['booking on, write-back the string "true"', { ...saved(true, [GRANT]), aiCallWriteback: 'true' }, false],
        ['booking off, write-back on', { ...saved(false, [GRANT]), aiCallWriteback: true }, false],
        // R2: booking is active while a region has a rep, so an empty specialists list no longer reads as booking off.
        ['booking on, write-back on, no specialist (routing names the reps)', { ...saved(true, []), aiCallWriteback: true }, true],
      ])('liveCallBooking: %s gives active %s', (_label, settings, active) => {
        expect(bookingActive(liveCallBooking({ settings }, []))).toBe(active);
      });

      it('liveCallBooking changes only the on switch; the rest is bookingSettings as it was', () => {
        const settings = { ...saved(true, [OTHER]), aiCallWriteback: false };
        expect(liveCallBooking({ settings }, [GRANT])).toEqual({ ...bookingSettings({ settings }, [GRANT]), enabled: false });
      });

      it.each([
        ['booking off, a specialist saved', saved(false, [GRANT]), [], true],
        ['booking off, write-back off, the configured default owner', {}, [GRANT], true],
        ['booking on', { ...saved(true, [GRANT]), aiCallWriteback: true }, [], true],
        // R2: the routing defaults name reps, so an empty specialists list still offers times.
        ['no specialist anywhere (routing names the reps)', saved(false, []), [], true],
        ['a saved empty list (routing names the reps)', saved(false, []), [GRANT], true],
      ])('practiceBooking: %s gives active %s whatever the toggles', (_label, settings, defaults, active) => {
        expect(bookingActive(practiceBooking({ settings }, defaults))).toBe(active);
      });

      it('a saved empty specialists list still beats the configured default', () => {
        expect(practiceBooking({ settings: saved(false, []) }, [GRANT]).specialists).toEqual([]);
      });

      it('practiceBooking never changes conversion or the hours', () => {
        const settings = { aiCallBooking: { ...DEFAULT_BOOKING, specialists: [GRANT], convertLeads: false } };
        expect(practiceBooking({ settings }, [])).toEqual({ ...DEFAULT_ROUTED, specialists: [GRANT], enabled: true });
      });
    });

    const noReps = { ...DEFAULT_BOOKING_ROUTING, regions: DEFAULT_BOOKING_ROUTING.regions.map((r) => ({ ...r, reps: [] })) };
    const oneRep = { ...DEFAULT_BOOKING_ROUTING, regions: DEFAULT_BOOKING_ROUTING.regions.map((r, i) => ({ ...r, reps: i === 1 ? [SETH] : [] })) };

    // R2: booking is active when it is on and some region has a rep; the specialists list no longer matters.
    it.each([
      ['on with a specialist', { enabled: true, specialists: [GRANT] }, true],
      ['on with no specialists, default routing', { enabled: true, specialists: [] }, true],
      ['off with a specialist', { enabled: false, specialists: [GRANT] }, false],
      ['off, default routing', { enabled: false }, false],
      ['on, but every region has no reps', { enabled: true, specialists: [GRANT], routing: noReps }, false],
      ['on, and only one region has a rep', { enabled: true, specialists: [], routing: oneRep }, true],
    ])('bookingActive: %s', (_label, over, expected) => {
      expect(bookingActive({ ...DEFAULT_BOOKING, ...over })).toBe(expected);
    });

    describe('routing defaults', () => {
      it('DEFAULT_BOOKING_ROUTING parses with the contract and is the spec\'s regions, reps, start times and start places', () => {
        expect(BookingRouting.safeParse(DEFAULT_BOOKING_ROUTING).success).toBe(true);
        expect(DEFAULT_BOOKING_ROUTING).toEqual({
          officeAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612',
          regions: [
            {
              key: 'LA',
              counties: ['Los Angeles', 'Orange', 'Riverside', 'San Bernardino'],
              reps: [CHANCE, BLAKE],
              startTimes: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'],
            },
            {
              key: 'SD',
              counties: ['San Diego'],
              reps: [SETH, THOMAS],
              startTimes: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
              // Owner, 2026-10-20: Seth and Thomas start from San Diego, not the Irvine office.
              startAddress: '7480 Miramar Rd, San Diego, CA',
            },
          ],
        });
      });

      it('bookingRouting is the saved routing, else the defaults', () => {
        expect(bookingRouting(DEFAULT_BOOKING)).toEqual(DEFAULT_BOOKING_ROUTING);
        expect(bookingRouting({ ...DEFAULT_BOOKING, routing: noReps })).toEqual(noReps);
      });

      it('the shared defaults cannot be changed by a caller', () => {
        expect(() => bookingRouting(DEFAULT_BOOKING).regions[0]!.reps.push(OTHER)).toThrow(TypeError);
        expect(DEFAULT_BOOKING_ROUTING.regions[0]!.reps).toEqual([CHANCE, BLAKE]);
      });
    });
  });
});

describe('samEmailSettings', () => {
  const OFF = { enabled: false, pausedAt: null, pausedReason: null };

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'oops'],
    ['an array', [{ enabled: true }]],
    ['samEmail missing', { aiDailyBudgetUsd: 25 }],
    ['samEmail a string', { samEmail: 'on' }],
    ['samEmail an array', { samEmail: [true] }],
    ['samEmail null', { samEmail: null }],
  ])('is off for %s', (_label, settings) => {
    expect(samEmailSettings({ settings })).toEqual(OFF);
  });

  it.each([
    ['the string "yes"', 'yes'],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('is off unless enabled is exactly true (%s)', (_label, enabled) => {
    expect(samEmailSettings({ settings: { samEmail: { enabled } } }).enabled).toBe(false);
  });

  it('is on when enabled is true, with no pause', () => {
    expect(samEmailSettings({ settings: { samEmail: { enabled: true } } })).toEqual({ enabled: true, pausedAt: null, pausedReason: null });
  });

  it('reads the pause the way pauseSamEmail writes it', () => {
    const settings = { samEmail: { enabled: true, pausedAt: '2026-10-20T17:00:00.000Z', pausedReason: 'complaint' } };
    expect(samEmailSettings({ settings })).toEqual({ enabled: true, pausedAt: '2026-10-20T17:00:00.000Z', pausedReason: 'complaint' });
  });

  it('ignores a pause reason that is not a string', () => {
    const settings = { samEmail: { enabled: true, pausedAt: '2026-10-20T17:00:00.000Z', pausedReason: 7 } };
    expect(samEmailSettings({ settings }).pausedReason).toBeNull();
  });

  it('a pause marker that is junk still pauses: junk can only make Sam email less, never more', () => {
    for (const pausedAt of [true, 1, {}, ['x'], '']) {
      const read = samEmailSettings({ settings: { samEmail: { enabled: true, pausedAt } } });
      expect(read.pausedAt, JSON.stringify(pausedAt)).not.toBeNull();
    }
  });

  it('does not disturb the other settings, and they do not disturb it', () => {
    const settings = { aiDailyBudgetUsd: 40, samEmail: { enabled: true } };
    expect(samEmailSettings({ settings }).enabled).toBe(true);
    expect(outreachSettings({ settings }).aiDailyBudgetUsd).toBe(40);
  });
});
