import { describe, expect, it } from 'vitest';
import { repDialAction, SENSITIVE } from './checks';

// Ruling (user, 2026-08-26, FINAL) — see .superpowers/sdd/rep-gates-brief.md.
// Non-admin reps never see the pre-dial checklist: ALLOW places the call,
// a benign REQUIRE_REVIEW auto-acknowledges and places the call, and a
// REQUIRE_REVIEW with a failing SENSITIVE check (or a BLOCK) refuses.
describe('repDialAction', () => {
  it('places the call outright on ALLOW', () => {
    expect(repDialAction({ decision: 'ALLOW', checks: [] })).toBe('call');
  });

  it('auto-acknowledges REQUIRE_REVIEW when every failing check is benign', () => {
    expect(
      repDialAction({
        decision: 'REQUIRE_REVIEW',
        checks: [
          { name: 'recording_consent', passed: false },
          { name: 'federal_dnc', passed: true },
          { name: 'calling_hours', passed: false },
        ],
      }),
    ).toBe('call-acknowledged');
  });

  it('refuses REQUIRE_REVIEW when any failing check is SENSITIVE', () => {
    for (const sensitive of SENSITIVE) {
      expect(
        repDialAction({
          decision: 'REQUIRE_REVIEW',
          checks: [
            { name: 'recording_consent', passed: false },
            { name: sensitive, passed: false },
          ],
        }),
      ).toBe('refuse');
    }
  });

  it('does not refuse on a SENSITIVE check name that passed', () => {
    expect(
      repDialAction({
        decision: 'REQUIRE_REVIEW',
        checks: [
          { name: 'neighbor_spoof', passed: true },
          { name: 'recording_consent', passed: false },
        ],
      }),
    ).toBe('call-acknowledged');
  });

  it('refuses on BLOCK regardless of which checks failed', () => {
    expect(
      repDialAction({
        decision: 'BLOCK',
        checks: [{ name: 'federal_dnc', passed: false }],
      }),
    ).toBe('refuse');
  });

  it('treats decision as authoritative: ALLOW calls even with a failing sensitive check', () => {
    expect(
      repDialAction({
        decision: 'ALLOW',
        checks: [{ name: 'attestation', passed: false }],
      }),
    ).toBe('call');
  });

  it('auto-acknowledges REQUIRE_REVIEW with no failing checks at all', () => {
    expect(
      repDialAction({
        decision: 'REQUIRE_REVIEW',
        checks: [{ name: 'federal_dnc', passed: true }],
      }),
    ).toBe('call-acknowledged');
  });
});
