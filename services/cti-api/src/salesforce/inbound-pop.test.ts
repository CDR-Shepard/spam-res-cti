import { describe, expect, it } from 'vitest';
import { popRecordFor } from './inbound-pop.js';

describe('popRecordFor — Opportunity → Deal → Lead → Contact, never an Account', () => {
  it('a Contact with an open Opportunity pops the Opportunity', () => { expect(popRecordFor({ whoId: '003A', openOpportunityId: '006B' })).toBe('006B'); });
  it('a matched Opportunity (whatId 006) pops itself', () => { expect(popRecordFor({ whoId: '003A', whatId: '006C' })).toBe('006C'); });
  it('a Deal (custom whatId) beats a Lead and a Contact', () => { expect(popRecordFor({ whoId: '00QL', whatId: 'a0XD' })).toBe('a0XD'); });
  it('a Lead beats a Contact', () => { expect(popRecordFor({ whoId: '00QL' })).toBe('00QL'); });
  it('a Contact with nothing else pops the Contact', () => { expect(popRecordFor({ whoId: '003A' })).toBe('003A'); });
  it('never an Account, and nothing when there is nothing', () => { expect(popRecordFor({ whatId: '001X' })).toBeNull(); expect(popRecordFor({})).toBeNull(); });
});
