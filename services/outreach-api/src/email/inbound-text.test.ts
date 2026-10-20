import { describe, expect, it } from 'vitest';
import { renderEmail } from './render.js';
import { htmlToText, isAutoReply, isOptOutText, stripQuoted } from './inbound-text.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz';
const URL = `https://api.example.com/api/email/unsubscribe/${TOKEN}`;
const COMPANY = 'GG Homes';
const OPTS = { companyName: COMPANY };

/** Our real outgoing footer, so these tests break if render and strip ever drift apart. */
const ours = renderEmail({
  body: 'Hi Jo, any interest?',
  token: TOKEN,
  apiPublicUrl: 'https://api.example.com',
  replyDomain: 'reply.rethinkre.team',
  postalAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612',
  companyName: COMPANY,
  inReplyTo: null,
  references: null,
});
const ourText = ours.text;

describe('stripQuoted', () => {
  it('keeps a reply with no quote as it is (trimmed)', () => {
    expect(stripQuoted('  Sounds good\n\nTalk soon  \n')).toBe('Sounds good\n\nTalk soon');
  });

  it('cuts at a one-line "On … wrote:"', () => {
    const body = 'Sounds good\n\nOn Tue, Oct 20, 2026 at 9:00 AM Sam <sam@rethinkre.team> wrote:\n> earlier text';
    expect(stripQuoted(body)).toBe('Sounds good');
  });

  it('cuts at a two-line "On … wrote:" (Gmail wraps long attributions)', () => {
    const body = 'Yes please\n\nOn Tue, Oct 20, 2026 at 9:00 AM Sam Assistant <sam+abc@reply.rethinkre.team>\nwrote:\n\nearlier text, not quoted with >';
    expect(stripQuoted(body)).toBe('Yes please');
  });

  it('does not cut at a line that merely begins with "On"', () => {
    expect(stripQuoted('On Tuesday I am free.\nOn Friday too.')).toBe('On Tuesday I am free.\nOn Friday too.');
  });

  it('cuts at -----Original Message-----', () => {
    expect(stripQuoted('Call me\n\n-----Original Message-----\nFrom: Sam\nSent: Tuesday')).toBe('Call me');
    expect(stripQuoted('Call me\n----- Original Message -----\nold')).toBe('Call me');
  });

  it('cuts at the Outlook underscore rule', () => {
    expect(stripQuoted('Call me\n\n________________________________\nFrom: Sam\nSent: Tuesday')).toBe('Call me');
  });

  it('cuts at a From: line that is followed by Sent: or Date:', () => {
    expect(stripQuoted('Call me\n\nFrom: Sam <sam@x.example>\nSent: Tuesday\nTo: Jo')).toBe('Call me');
    expect(stripQuoted('Call me\n\nFrom: Sam <sam@x.example>\nDate: Tuesday\nTo: Jo')).toBe('Call me');
  });

  it('keeps a From: line that is not followed by Sent:/Date:', () => {
    expect(stripQuoted('Heard from: someone\nFrom: my cousin\nShe likes it')).toBe('Heard from: someone\nFrom: my cousin\nShe likes it');
  });

  it('cuts at the first line starting with >', () => {
    expect(stripQuoted('Fine by me\n> old\n> older\nmore of mine')).toBe('Fine by me');
    expect(stripQuoted('Fine by me\n  > indented quote')).toBe('Fine by me');
  });

  it('cuts at the earliest marker when several are present', () => {
    expect(stripQuoted('A\n> q\nOn Mon, X wrote:\nB')).toBe('A');
    expect(stripQuoted('A\nOn Mon, X wrote:\n> q')).toBe('A');
  });

  it('handles CRLF', () => {
    expect(stripQuoted('Yes\r\n\r\nOn Mon, X wrote:\r\n> q')).toBe('Yes');
  });

  it('returns an empty string when the whole message is quoted', () => {
    expect(stripQuoted('> only the quote')).toBe('');
  });

  // Review Focus 1: our own footer says "unsubscribe" and must never read as the seller opting out.
  describe('our own footer (Review Focus 1)', () => {
    const quoted = 'Sounds good\n\nOn Tue, Oct 20, 2026 at 9:00 AM Sam <sam@rethinkre.team> wrote:\n> To stop hearing from Sam, unsubscribe here: https://x/api/email/unsubscribe/abc';

    it('is not an opt-out when quoted behind an attribution line', () => {
      expect(isOptOutText(stripQuoted(quoted))).toBe(false);
      expect(isOptOutText(stripQuoted(quoted, OPTS))).toBe(false);
    });

    it('is dropped when top-posted with no marker, with or without the company name', () => {
      const topPosted = `Sounds good\n\n${ourText}`;
      for (const out of [stripQuoted(topPosted), stripQuoted(topPosted, OPTS)]) {
        expect(out).toBe('Sounds good\n\nHi Jo, any interest?');
        expect(isOptOutText(out)).toBe(false);
      }
    });

    it('is dropped when the bare footer lines survive a client that strips the > marks', () => {
      const flattened = `Sounds good\n\n${ourText.split('\n').slice(1).join('\n')}`;
      expect(isOptOutText(stripQuoted(flattened))).toBe(false);
      expect(stripQuoted(flattened)).not.toMatch(/unsubscribe|AI assistant|·/);
    });

    it('is dropped on its own line even when only the unsubscribe line is present', () => {
      expect(stripQuoted(`Yes\nTo stop hearing from Sam, unsubscribe here: ${URL}`)).toBe('Yes');
    });

    it('is dropped with a company name that has a different spelling, and the footer is not mistaken for the seller\'s text', () => {
      const other = ourText.replace(/GG Homes/g, 'Acme Realty & Co');
      expect(stripQuoted(`Ok\n\n${other}`)).toBe('Ok\n\nHi Jo, any interest?');
      expect(stripQuoted(`Ok\n\n${other}`, { companyName: 'Acme Realty & Co' })).toBe('Ok\n\nHi Jo, any interest?');
    });

    it('keeps a seller who signs off as "Sam" or sends a lone dash', () => {
      expect(stripQuoted('Thanks,\nSam')).toBe('Thanks,\nSam');
      expect(stripQuoted('—\nSam')).toBe('—\nSam');
    });

    it('keeps a seller\'s own " · " line when it is not next to our unsubscribe line', () => {
      expect(stripQuoted('Open house · Saturday')).toBe('Open house · Saturday');
    });

    it('is dropped from an HTML-only reply that quotes our HTML footer with no attribution line', () => {
      const html = `<p>Sounds good</p>\n${ours.html}`;
      for (const out of [stripQuoted(htmlToText(html)), stripQuoted(htmlToText(html), OPTS)]) {
        expect(out).toBe('Sounds good\n\nHi Jo, any interest?');
        expect(isOptOutText(out)).toBe(false);
      }
    });

    it('still reads a genuine opt-out written above our footer', () => {
      expect(isOptOutText(stripQuoted(`Please unsubscribe me\n\n${ourText}`))).toBe(true);
    });
  });
});

describe('htmlToText', () => {
  it('turns block tags and <br> into newlines and strips the rest', () => {
    expect(htmlToText('<div>Hello<br>there</div><p>Second <b>bold</b> para</p>')).toBe('Hello\nthere\n\nSecond bold para');
  });

  it('drops script, style and comments with their contents', () => {
    expect(htmlToText('<style>p{color:red}</style><!-- hidden --><script>alert(1)</script><p>Visible</p>')).toBe('Visible');
  });

  it('decodes the common entities once, without re-decoding', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &quot;us&quot; &#39;ok&#39; &nbsp;done &#x41;&#66; &amp;lt;</p>')).toBe('Tom & Jerry <3 "us" \'ok\' done AB &lt;');
  });

  it('does not let decoded angle brackets become tags', () => {
    expect(htmlToText('<p>&lt;b&gt;not bold&lt;/b&gt;</p>')).toBe('<b>not bold</b>');
  });

  it('collapses runs of 3+ newlines to a single blank line and trims', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><br><br><p>b</p>')).toBe('a\n\nb');
  });

  it('keeps attribute text such as > inside an attribute from leaking', () => {
    expect(htmlToText('<a href="x" title="a > b">link</a> text')).toBe('link text');
  });

  it('lets stripQuoted find a Gmail attribution line', () => {
    const html = '<div>Sounds good</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Oct 20, 2026 at 9:00 AM Sam &lt;sam@rethinkre.team&gt; wrote:<br></div><blockquote>old text</blockquote></div>';
    expect(stripQuoted(htmlToText(html))).toBe('Sounds good');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  it('keeps a bare < in text and drops a tag left unterminated at the end', () => {
    expect(htmlToText('<p>1 < 2 and 3 <4</p>')).toBe('1 < 2 and 3 <4');
    expect(htmlToText('Hello <b')).toBe('Hello');
  });

  it('keeps text around a script, style or title with no closing tag', () => {
    expect(htmlToText('<script>x<p>after</p>')).toBe('x\nafter');
    expect(htmlToText('<title>T<p>after</p>')).toBe('T\nafter');
  });

  it('treats <header> as a block, not as <head>', () => {
    expect(htmlToText('<header>Top</header><p>Body</p>')).toBe('Top\n\nBody');
  });

  it('treats source line breaks as spaces, like a browser', () => {
    expect(htmlToText('<p>Hello\r\nthere\nfriend</p>')).toBe('Hello there friend');
  });

  // Seller-controlled input: nothing here may take quadratic time.
  it('stays fast on adversarial input', () => {
    const started = Date.now();
    htmlToText('<a "'.repeat(60_000));
    htmlToText('<script>'.repeat(60_000));
    htmlToText('<!--'.repeat(60_000));
    htmlToText('<p title="'.repeat(60_000));
    htmlToText('&a'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('isAutoReply', () => {
  const plain = { headers: {}, from: 'Jo Smith <jo@example.com>', subject: 'Re: your home' };

  it('is false for a plain reply', () => {
    expect(isAutoReply(plain)).toBe(false);
    expect(isAutoReply({ ...plain, headers: { 'auto-submitted': 'no', precedence: 'normal' } })).toBe(false);
  });

  it('is true for Auto-Submitted unless it is "no"', () => {
    expect(isAutoReply({ ...plain, headers: { 'auto-submitted': 'auto-replied' } })).toBe(true);
    expect(isAutoReply({ ...plain, headers: { 'auto-submitted': 'auto-generated' } })).toBe(true);
    expect(isAutoReply({ ...plain, headers: { 'auto-submitted': ' No ' } })).toBe(false);
  });

  it('is true when X-Autoreply or X-Autorespond is present', () => {
    expect(isAutoReply({ ...plain, headers: { 'x-autoreply': 'yes' } })).toBe(true);
    expect(isAutoReply({ ...plain, headers: { 'x-autorespond': '' } })).toBe(true);
  });

  it('is true for a bulk, junk, list or auto_reply Precedence', () => {
    for (const precedence of ['bulk', 'junk', 'list', 'auto_reply', ' Bulk ']) {
      expect(isAutoReply({ ...plain, headers: { precedence } }), precedence).toBe(true);
    }
  });

  it('accepts header names in any case', () => {
    expect(isAutoReply({ ...plain, headers: { 'Auto-Submitted': 'auto-replied' } })).toBe(true);
    expect(isAutoReply({ ...plain, headers: { 'X-AutoReply': '1' } })).toBe(true);
    expect(isAutoReply({ ...plain, headers: { Precedence: 'Bulk' } })).toBe(true);
  });

  it('is true for a robot sender, with or without a display name or plus tag', () => {
    for (const from of ['mailer-daemon@example.com', 'Mail Delivery <MAILER-DAEMON@example.com>', 'postmaster@example.com', 'no-reply@example.com', 'noreply@example.com', 'NoReply+abc@example.com']) {
      expect(isAutoReply({ ...plain, from }), from).toBe(true);
    }
  });

  it('stays fast on a huge From header', () => {
    const started = Date.now();
    isAutoReply({ ...plain, from: 'a'.repeat(200_000) });
    isAutoReply({ ...plain, from: `${'a<'.repeat(100_000)}x` });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('is false for a sender that only contains one of those words', () => {
    expect(isAutoReply({ ...plain, from: 'noreplyfan@example.com' })).toBe(false);
  });

  it('is true for an auto-reply subject, case-insensitively', () => {
    for (const subject of ['Out of Office: back Monday', 'out of office', 'Automatic reply: hi', 'Auto: gone', 'Undeliverable: Re: hi', 'Delivery Status Notification (Failure)', 'Returned mail: see transcript']) {
      expect(isAutoReply({ ...plain, subject }), subject).toBe(true);
    }
  });

  it('is false when the subject only mentions those words later on', () => {
    expect(isAutoReply({ ...plain, subject: 'Re: I am out of office next week' })).toBe(false);
  });
});

describe('isOptOutText', () => {
  it('is true for a bare opt-out word, ignoring case and punctuation', () => {
    for (const t of ['STOP!', 'stop', 'Unsubscribe.', ' remove ', 'Remove me', 'opt out', 'opt-out', 'OPTOUT', 'Cancel', 'stop.\n']) {
      expect(isOptOutText(t), t).toBe(true);
    }
  });

  it('is true when an opt-out phrase appears anywhere', () => {
    for (const t of [
      'please take me off your list',
      'Please UNSUBSCRIBE me',
      'Remove me from this list please',
      'stop emailing me',
      'Stop contacting me.',
      'stop calling',
      'stop texting',
      'do not contact me again',
      "don't contact me",
      'Do not email',
      'Don’t email me again', // curly apostrophe
      'leave me alone',
      'stop\nemailing me',
    ]) {
      expect(isOptOutText(t), t).toBe(true);
    }
  });

  it('is false for ordinary text', () => {
    for (const t of ['you can stop by Tuesday', 'Sounds good', '', 'I need to cancel my dentist, but yes to a chat', 'Remove the tenant clause?']) {
      expect(isOptOutText(t), t).toBe(false);
    }
  });
});
