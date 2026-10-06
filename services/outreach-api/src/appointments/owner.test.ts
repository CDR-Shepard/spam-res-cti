import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import type { OwnerUser } from './calendar.js';
import { appointmentOwner } from './owner.js';

const GRANT = '0058X00000Fsx39QAB';
const X = '0058X00000Abcd1QAB';
const GONE = '0058X00000Zzzz9QAB';
const user = (sfUserId: string, isActive: boolean, firstName = 'Grant'): OwnerUser => ({ sfUserId, firstName, name: `${firstName} Person`, isActive, timeZone: 'America/Los_Angeles', zoneRefused: null });
const booking = (specialists: string[]) => ({ ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists });
const users = (...us: OwnerUser[]) => new Map(us.map((u) => [u.sfUserId, u]));

describe('appointmentOwner: the first ACTIVE user on the ordered list, nobody else', () => {
  it.each([
    ['1: [Grant], Grant active', [GRANT], users(user(GRANT, true)), GRANT],
    ['2: [Grant, X], Grant inactive, X active', [GRANT, X], users(user(GRANT, false), user(X, true, 'Xavier')), X],
    ['3: [Grant], Grant inactive', [GRANT], users(user(GRANT, false)), null],
    ['4: []', [], users(user(GRANT, true)), null],
    ['5: an id the User query did not return is skipped', [GONE, GRANT], users(user(GRANT, true)), GRANT],
    ['the order wins, not the map\'s order', [X, GRANT], users(user(GRANT, true), user(X, true, 'Xavier')), X],
    ['an active user not on the list is never chosen', [GRANT], users(user(GRANT, false), user(X, true)), null],
  ])('%s', (_label, specialists, us, expected) => {
    expect(appointmentOwner(booking(specialists), us)?.sfUserId ?? null).toBe(expected);
  });

  it('a 15-character id on the list matches the 18-character id Salesforce returns', () => {
    expect(appointmentOwner(booking([GRANT.slice(0, 15)]), users(user(GRANT, true)))?.sfUserId).toBe(GRANT);
  });

  it('the core comparison is case-sensitive (Salesforce ids are)', () => {
    expect(appointmentOwner(booking([GRANT.slice(0, 15).toLowerCase()]), users(user(GRANT, true)))).toBeNull();
  });
});
