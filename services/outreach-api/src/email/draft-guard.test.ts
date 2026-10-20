import { describe, expect, it } from 'vitest';
import { EMAIL_BODY_MAX, EMAIL_SUBJECT_MAX } from '@cti/contracts';
import { draftIssues } from './draft-guard.js';

const clean = { subject: 'Your home on Elm Street', body: 'Hello Jo,\n\nWould a short chat about your home work for you this week?\n\nSam' };

describe('draftIssues', () => {
  it('finds nothing in a clean draft', () => {
    expect(draftIssues(clean)).toEqual([]);
  });

  it('flags a subject that is empty, has a newline, or is over the max', () => {
    expect(draftIssues({ ...clean, subject: '' })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: '   ' })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: 'Two\nlines' })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: 'Two\r\nlines' })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: 'x'.repeat(EMAIL_SUBJECT_MAX + 1) })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: 'x'.repeat(EMAIL_SUBJECT_MAX) })).toEqual([]);
  });

  it('flags a body that is empty or over the max', () => {
    expect(draftIssues({ ...clean, body: '' })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: ' \n ' })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: 'x'.repeat(EMAIL_BODY_MAX + 1) })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: 'x'.repeat(EMAIL_BODY_MAX) })).toEqual([]);
  });

  it('flags a link in either part', () => {
    for (const text of ['see https://x.y', 'see http://x.y', 'see www.x.y', 'SEE HTTPS://X.Y']) {
      expect(draftIssues({ ...clean, body: text }), text).toHaveLength(1);
      expect(draftIssues({ ...clean, subject: text }), text).toHaveLength(1);
    }
  });

  it('flags a template placeholder', () => {
    expect(draftIssues({ ...clean, body: 'Hello {{name}},' })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: 'Hello [Name],' })).toHaveLength(1);
    expect(draftIssues({ ...clean, subject: 'About [address]' })).toHaveLength(1);
  });

  it('flags a dollar amount', () => {
    expect(draftIssues({ ...clean, body: 'offer of $450,000' })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: 'about $ 450k' })).toHaveLength(1);
    expect(draftIssues({ ...clean, body: 'the $ sign alone is fine' })).toEqual([]);
  });

  it('flags a claim to be human, straight or curly apostrophe', () => {
    for (const text of ["I'm a real person", 'I am a person', "I’m human", 'I am a real human', 'Honestly, I am not a bot', 'I am not an AI', 'not a robot']) {
      expect(draftIssues({ ...clean, body: text }), text).toHaveLength(1);
    }
  });

  it('does not flag ordinary uses of the words', () => {
    for (const text of ['Is the person who lives there the owner?', 'We are a team of people who buy homes.', 'I am happy to talk', 'The robot vacuum stays.']) {
      expect(draftIssues({ ...clean, body: text }), text).toEqual([]);
    }
  });

  it('flags the word unsubscribe, because the footer owns it', () => {
    expect(draftIssues({ ...clean, body: 'You can Unsubscribe any time' })).toHaveLength(1);
  });

  it('reports every problem it finds, once each, in plain words', () => {
    const issues = draftIssues({ subject: '', body: 'I am a real person, see https://x.y and www.z.com for $1000 {{name}} [Name] unsubscribe' });
    expect(issues).toHaveLength(6);
    for (const issue of issues) expect(issue).toMatch(/^[A-Z].*\.$/);
    expect(new Set(issues).size).toBe(issues.length);
  });
});
