import { describe, expect, it } from 'vitest';
import { callerMayCreateTaskOn, objectTypeForId } from './ownership.js';

describe('objectTypeForId', () => {
  it('maps standard key prefixes; custom objects are "other"', () => {
    expect(objectTypeForId('00Q000000000001AAA')).toBe('Lead');
    expect(objectTypeForId('003000000000001')).toBe('Contact');
    expect(objectTypeForId('006000000000001')).toBe('Opportunity');
    expect(objectTypeForId('00T000000000001')).toBe('Task');
    expect(objectTypeForId('a0B000000000001')).toBe('other');
  });
});

describe('callerMayCreateTaskOn', () => {
  const me = '005ME';
  it('Lead / Contact: owner only', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X' }, me)).toBe(false);
    expect(callerMayCreateTaskOn({ type: 'Contact', ownerId: me }, me)).toBe(true);
  });
  it('Opportunity: owner OR Lead_Manager__c', () => {
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: me, leadManagerId: null }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: '005Y' }, me)).toBe(false);
  });
  it('Task: the assignee', () => {
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: '005X' }, me)).toBe(false);
  });
  it('objects the rule does not name are allowed', () => {
    expect(callerMayCreateTaskOn({ type: 'other', ownerId: '005X' }, me)).toBe(true);
  });
});
