import { describe, expect, it } from 'vitest';
import * as firewall from '@cti/firewall';
import { blockedTargets } from './consent-check.js';
import { withinCallingHours } from './pick-did.js';

/**
 * One definition of each rule: the dialer's calling-hours pre-filter and its
 * consent gate live in @cti/firewall, where the outreach planner reads them
 * too. These pin that pick-did.ts and consent-check.ts hand out the
 * firewall's functions themselves, not copies that could drift.
 */
describe('the dialer uses the firewall rules, not copies', () => {
  it('withinCallingHours is @cti/firewall’s', () => {
    expect(withinCallingHours).toBe(firewall.withinCallingHours);
  });

  it('blockedTargets is @cti/firewall’s', () => {
    expect(blockedTargets).toBe(firewall.blockedTargets);
  });
});
