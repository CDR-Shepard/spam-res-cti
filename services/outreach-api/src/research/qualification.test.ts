import { describe, expect, it } from 'vitest';
import { QUALIFICATION_TOPICS, type QualificationTopic } from '@cti/contracts';
import {
  DECLINED_VALUES,
  EXTRA_FIELDS,
  NEVER_WRITE_VALUES,
  PLACEHOLDER_VALUES,
  QUALIFICATION_FIELDS,
  isBlankish,
  missingTopics,
  qualificationFieldNames,
  type FieldKind,
} from './qualification.js';

const f = (name: string, value: string) => ({ name, value });
const allBut = (...present: QualificationTopic[]) => QUALIFICATION_TOPICS.filter((t) => t !== 'decision_makers' && !present.includes(t));

describe('missingTopics', () => {
  it.each<[string, 'Lead' | 'Opportunity', Array<{ name: string; value: string }>, QualificationTopic[]]>([
    ['1: a Lead whose only answer is a placeholder misses every topic but decision_makers', 'Lead', [f('Timeline__c', "I Didn't Ask")], allBut()],
    ['2: a real timeline answers timeline', 'Lead', [f('Timeline__c', '90 Days')], allBut('timeline')],
    ['3: a multipicklist of placeholders only is missing', 'Lead', [f('Competition__c', "I Didn't Ask;Seller Didn't Say")], allBut()],
    ['4: one real value in a multipicklist answers it', 'Lead', [f('Competition__c', "I Didn't Ask;Has Offers")], allBut('competition')],
    ['5: a Lead roof issue answers repairs without Major_Repairs_Needed__c', 'Lead', [f('Roof_Issues__c', 'true')], allBut('repairs')],
    ['6: an Opportunity asking price answers price', 'Opportunity', [f('SellersAskingPrice__c', '350000')], allBut('price')],
    ['7: a zero asking price is missing', 'Lead', [f('Seller_s_Asking_Price__c', '0')], allBut()],
    ['9: an Opportunity reason for selling answers motivation', 'Opportunity', [f('Motivation__c', ' '), f('Reason_For_Selling__c', 'moving')], allBut('motivation')],
    ['a Lead never reads the Opportunity-only reason field', 'Lead', [f('Reason_For_Selling__c', 'moving')], allBut()],
    ['field names match whatever their case', 'Lead', [f('timeline__C', '90 Days')], allBut('timeline')],
    ['a declined answer is still missing', 'Lead', [f('Occupancy__c', "Seller Wouldn't Disclose")], allBut()],
    ['a secondary motivation alone answers motivation', 'Lead', [f('SecondaryMotivation__c', 'Divorce')], allBut('motivation')],
    ['a false boolean does not answer repairs', 'Lead', [f('Mold__c', 'false'), f('Foundation_Issues__c', 'false')], allBut()],
    ['Spanish speaker is no topic', 'Lead', [f('Spanish_Speaker__c', 'true')], allBut()],
  ])('%s', (_label, sfObject, fields, expected) => {
    expect(missingTopics(sfObject, fields)).toEqual(expected);
  });

  it('a fully answered Opportunity misses nothing, and the order is QUALIFICATION_TOPICS order', () => {
    const full = [
      f('Motivation__c', 'Tired Landlord'),
      f('Timeline__c', '30 Days'),
      f('Condition__c', 'Fair'),
      f('Major_Repairs_Needed__c', 'Roof'),
      f('Occupancy__c', 'Vacant'),
      f('SellersAskingPrice__c', '1'),
      f('Competition__c', 'Listed'),
      f('Amount_Owed__c', '12'),
    ];
    expect(missingTopics('Opportunity', full)).toEqual([]);
    expect(missingTopics('Opportunity', full.slice(1, 3))).toEqual(['motivation', 'repairs', 'occupancy', 'price', 'competition', 'mortgage']);
  });

  it('never lists decision_makers: it has no field', () => {
    expect(missingTopics('Lead', [])).not.toContain('decision_makers');
    expect(missingTopics('Opportunity', [])).not.toContain('decision_makers');
  });
});

describe('isBlankish', () => {
  it.each<[string | null | undefined, FieldKind, boolean]>([
    ["i didn't ask", 'picklist', true], // 8
    ["I DIDN'T ASK", 'text', true],
    ["Didn't Ask", 'picklist', true],
    ['Unsure', 'picklist', true],
    ["Seller Wouldn't Say", 'picklist', true],
    ['90 Days', 'picklist', false],
    [null, 'picklist', true],
    [undefined, 'text', true],
    ['', 'text', true],
    ['   ', 'currency', true],
    ["I Didn't Ask;Seller Didn't Say", 'multipicklist', true],
    ["I Didn't Ask; Has Offers", 'multipicklist', false],
    ['false', 'boolean', true],
    ['true', 'boolean', false],
    ['0', 'currency', true],
    ['0.0', 'currency', true],
    ['350000', 'currency', false],
    ['moving', 'text', false],
  ])('%j as %s is blankish: %s', (value, kind, expected) => {
    expect(isBlankish(value, kind, undefined)).toBe(expected);
  });
});

describe('the value sets', () => {
  it('placeholders are the never-write values plus the declined values plus unsure, lower-cased', () => {
    expect([...NEVER_WRITE_VALUES].sort()).toEqual(["didn't ask", "i didn't ask"]);
    expect([...DECLINED_VALUES].sort()).toEqual(["seller didn't say", "seller wouldn't disclose", "seller wouldn't say"]);
    expect([...PLACEHOLDER_VALUES].sort()).toEqual([...NEVER_WRITE_VALUES, ...DECLINED_VALUES, 'unsure'].sort());
  });
});

describe('QUALIFICATION_FIELDS', () => {
  const names = (o: 'Lead' | 'Opportunity', t: QualificationTopic) => (QUALIFICATION_FIELDS[o][t] ?? []).map((x) => `${x.field}:${x.kind}${x.trueOnly ? ':trueOnly' : ''}`);
  it('follows the spec map for the Lead', () => {
    expect(names('Lead', 'motivation')).toEqual(['Motivation__c:picklist', 'SecondaryMotivation__c:picklist']);
    expect(names('Lead', 'repairs')).toEqual(['Major_Repairs_Needed__c:multipicklist', 'Roof_Issues__c:boolean:trueOnly', 'Foundation_Issues__c:boolean:trueOnly', 'Mold__c:boolean:trueOnly']);
    expect(names('Lead', 'price')).toEqual(['Seller_s_Asking_Price__c:currency']);
    expect(names('Lead', 'competition')).toEqual(['Competition__c:multipicklist']);
    expect(names('Lead', 'mortgage')).toEqual(['Amount_Owed__c:currency']);
    expect(names('Lead', 'decision_makers')).toEqual([]);
  });
  it('follows the spec map for the Opportunity', () => {
    expect(names('Opportunity', 'motivation')).toEqual(['Motivation__c:picklist', 'SecondaryMotivation__c:picklist', 'Reason_For_Selling__c:text']);
    expect(names('Opportunity', 'repairs')).toEqual(['Major_Repairs_Needed__c:multipicklist']);
    expect(names('Opportunity', 'price')).toEqual(['SellersAskingPrice__c:currency']);
    for (const t of ['timeline', 'condition', 'occupancy'] as const) expect(names('Opportunity', t)).toEqual(names('Lead', t));
  });
  it('keeps Spanish speaker outside the topics, true-only', () => {
    for (const o of ['Lead', 'Opportunity'] as const) expect(EXTRA_FIELDS[o].language).toEqual([{ field: 'Spanish_Speaker__c', kind: 'boolean', trueOnly: true }]);
  });
});

describe('Fix 1 (I-2): a field research never read is unknown, not missing', () => {
  it('lists every qualification and extra field of each object once, topics first', () => {
    expect(qualificationFieldNames('Lead')).toEqual([
      'Motivation__c', 'SecondaryMotivation__c', 'Timeline__c', 'Condition__c', 'Major_Repairs_Needed__c', 'Roof_Issues__c', 'Foundation_Issues__c', 'Mold__c',
      'Occupancy__c', 'Seller_s_Asking_Price__c', 'Competition__c', 'Amount_Owed__c', 'Spanish_Speaker__c',
    ]);
    expect(qualificationFieldNames('Opportunity')).toContain('Reason_For_Selling__c');
    expect(qualificationFieldNames('Opportunity')).toContain('SellersAskingPrice__c');
    expect(new Set(qualificationFieldNames('Opportunity')).size).toBe(qualificationFieldNames('Opportunity').length);
  });

  it('a topic none of whose fields was read is not missing', () => {
    expect(missingTopics('Lead', [], ['Timeline__c', 'Condition__c'])).toEqual(['timeline', 'condition']);
  });

  it('matches the read names case-insensitively', () => {
    expect(missingTopics('Lead', [], ['timeline__c'])).toEqual(['timeline']);
  });

  it('a topic is answered by any read field, and unread fields of it are ignored', () => {
    expect(missingTopics('Lead', [{ name: 'Mold__c', value: 'true' }], ['Major_Repairs_Needed__c', 'Mold__c'])).not.toContain('repairs');
    expect(missingTopics('Lead', [], ['Major_Repairs_Needed__c'])).toEqual(['repairs']);
  });

  it('nothing read at all: nothing is missing', () => {
    expect(missingTopics('Opportunity', [], [])).toEqual([]);
  });

  it('without a read list (a snapshot from before Fix 1) every field counts as read', () => {
    expect(missingTopics('Lead', [], undefined)).toEqual(QUALIFICATION_TOPICS.filter((t) => t !== 'decision_makers'));
  });
});

describe('5a Fix 1 (I-1): zero is blank per field', () => {
  it('a zero amount owed is a real answer ("free and clear"); a zero asking price is a placeholder', () => {
    expect(isBlankish('0', 'currency', 'Amount_Owed__c')).toBe(false);
    expect(isBlankish('0.0', 'currency', 'amount_owed__C')).toBe(false);
    expect(isBlankish('0', 'currency', 'Seller_s_Asking_Price__c')).toBe(true);
    expect(isBlankish('0', 'currency', 'SellersAskingPrice__c')).toBe(true);
    expect(isBlankish(null, 'currency', 'Amount_Owed__c')).toBe(true);
    expect(isBlankish(' ', 'currency', 'Amount_Owed__c')).toBe(true);
  });
  it('missingTopics follows the same rule: amount owed 0 answers mortgage, asking price 0 does not answer price', () => {
    expect(missingTopics('Lead', [f('Amount_Owed__c', '0')])).toEqual(allBut('mortgage'));
    expect(missingTopics('Opportunity', [f('Amount_Owed__c', '0'), f('SellersAskingPrice__c', '0')])).toEqual(allBut('mortgage'));
  });
});
