import { describe, expect, it } from 'vitest';
import { resolveRecipientState } from './index.js';
import { resolveTimezone } from '@cti/firewall';

/**
 * FIX-3 (weekend-calling fix wave): `evaluate()` resolves the recipient's tz
 * in priority order — SF record address, then the dialed number's area code
 * — and the STATE is supposed to piggyback on whichever source won. But the
 * SF-address branch only sets `resolvedState` when `resolveTimezone` matched
 * via 'state' (a real US state on the record); when it instead matches via
 * 'country' (state blank, country "US" — resolveTimezone's US-or-unknown
 * fallback landing on the country table because no state code was usable),
 * tz resolves fine but state stays null. Because the
 * area-code fallback for STATE lived inside the SAME `if (!resolvedTz)` guard
 * as the area-code fallback for TZ, and tz was already resolved (via
 * country), that fallback never ran either — so `resolvedState` stayed null
 * for every dial to such a record, which after the weekend-calling ruling
 * means the record falls to the conservative UNKNOWN_STATE_RULE (Sunday
 * banned) even for e.g. a plainly-CA lead.
 *
 * The fix: after both tz-resolution attempts, if `resolvedState` is STILL
 * null, fall back to the area code of the DIALED NUMBER — the exact same
 * source the tz-unresolved path already uses — independent of whether tz
 * itself came from a state or a country match. `resolveRecipientState` is
 * that fallback step, extracted so it's directly testable without standing
 * up the whole `evaluate()` pipeline (db, SF client), same pattern as
 * `callingWindowFor`/`callingHoursGateCheck`.
 */
describe('resolveRecipientState — the area-code fallback for a country-matched tz', () => {
  it('reproduces the reviewer scenario: SF address state empty, country "US" (tz matches via country), 619 number → CA', () => {
    const resolved = resolveTimezone({ state: null, country: 'US' });
    expect(resolved?.source).toBe('country'); // confirms the tz DID resolve, just not via state
    const alreadyResolvedState = resolved?.source === 'state' ? resolved.matched : null;
    expect(resolveRecipientState(alreadyResolvedState, '+16195551234')).toBe('CA');
  });

  it('passes an already-resolved state straight through (does not override a real state match)', () => {
    expect(resolveRecipientState('NY', '+16195551234')).toBe('NY');
  });

  it('falls back to the area code when resolvedState is null', () => {
    expect(resolveRecipientState(null, '+12055551234')).toBe('AL'); // 205 -> AL
  });

  it('stays null for a number whose area code has no state mapping (non-NANP)', () => {
    expect(resolveRecipientState(null, '+442071838750')).toBeNull();
  });

  it('stays null for a toll-free (non-geographic) NANP number', () => {
    expect(resolveRecipientState(null, '+18005551234')).toBeNull();
  });
});
