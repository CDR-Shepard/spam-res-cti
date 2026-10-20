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

  it('flags a bare domain or an email address, not only http(s) and www', () => {
    for (const text of ['visit gghomes.com', 'see Example.ORG/page', 'go to my-site.homes now', 'try rethink.team', 'call back at jo@example.net', 'mail Jo.Smith@x.example', 'a.b.co']) {
      expect(draftIssues({ ...clean, body: text }), text).toHaveLength(1);
      expect(draftIssues({ ...clean, subject: text }), text).toHaveLength(1);
    }
  });

  it('does not mistake ordinary sentences for a domain', () => {
    for (const text of ['It was nice talking. Homes like yours are rare.', 'I work at GG Homes.', 'Is 3.5 acres right?', 'See you Tue.', 'Thanks, Sam.']) {
      expect(draftIssues({ ...clean, body: text }), text).toEqual([]);
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

  it('flags a price written without a dollar sign', () => {
    for (const text of ['I can offer 450k', 'around 450 K', '450,000 dollars', '2 million for it', 'about 300 thousand', 'say 1.5 million', '500 USD', '12000 usd', '1 dollar']) {
      expect(draftIssues({ ...clean, body: text }), text).toHaveLength(1);
    }
  });

  it('does not mistake other numbers for a price', () => {
    for (const text of ['Would 2 minutes work?', 'Are there 5 kids in the house?', 'It has 3 bedrooms and 2 baths.', 'Call after 4 pm.', 'About 30 days?']) {
      expect(draftIssues({ ...clean, body: text }), text).toEqual([]);
    }
  });

  it('flags a claim to be human, straight or curly apostrophe', () => {
    for (const text of [
      "I'm a real person",
      'I am a person',
      "I’m human",
      'I am a real human',
      'I am an actual person',
      "I'm just a person",
      "I'm just a real person",
      'I am a living human',
      'Im an actual human',
      'Honestly, I am not a bot',
      'I am not an AI',
      'not a robot',
    ]) {
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

  // Sam's replies go out on their own: a quoted copy of her words must never read as an opt-out.
  it('refuses any draft that reads as an opt-out, in the subject or the body', () => {
    for (const text of ['Stop\n\nthanks for your time', 'stop emailing me is fine by us', 'we will never contact you again, do not contact us', 'just say take me off', 'Stop', 'remove me from', "don't email me back is ok"]) {
      expect(draftIssues({ ...clean, body: `${text}` }), text).not.toEqual([]);
    }
    const body = draftIssues({ ...clean, body: 'If you would rather not hear from us, say "stop emailing me".' });
    const subject = draftIssues({ ...clean, subject: 'Stop emailing me?' });
    expect(body).toEqual(['The body mentions stopping or unsubscribing; the footer handles that.']);
    expect(subject).toEqual(['The subject mentions stopping or unsubscribing; the footer handles that.']);
  });

  it('does not refuse ordinary words that only resemble an opt-out', () => {
    expect(draftIssues({ ...clean, body: 'Could I stop by Tuesday to see the home?' })).toEqual([]);
  });

  it('bounds its own work on an oversized draft', () => {
    const started = Date.now();
    const issues = draftIssues({ subject: 'a-'.repeat(500_000), body: 'a-'.repeat(500_000) });
    expect(issues.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports every problem it finds, once each, in plain words', () => {
    const issues = draftIssues({ subject: '', body: 'I am a real person, see https://x.y and www.z.com for $1000 {{name}} [Name] unsubscribe' });
    expect(issues).toHaveLength(6);
    for (const issue of issues) expect(issue).toMatch(/^[A-Z].*\.$/);
    expect(new Set(issues).size).toBe(issues.length);
  });
});
