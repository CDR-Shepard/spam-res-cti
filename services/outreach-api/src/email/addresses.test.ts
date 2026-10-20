import { describe, expect, it } from 'vitest';
import { parseMailbox, replyAddress, tokenFromRecipients, unsubscribeMailto, unsubscribeUrl } from './addresses.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz';
const DOMAIN = 'reply.rethinkre.team';

describe('replyAddress / unsubscribeMailto / unsubscribeUrl', () => {
  it('builds the plus-addressed reply and unsubscribe mailboxes', () => {
    expect(replyAddress(TOKEN, DOMAIN)).toBe(`sam+${TOKEN}@${DOMAIN}`);
    expect(unsubscribeMailto(TOKEN, DOMAIN)).toBe(`unsubscribe+${TOKEN}@${DOMAIN}`);
  });

  it('builds the one-click unsubscribe URL, with or without a trailing slash on the base', () => {
    expect(unsubscribeUrl('https://api.example.com', TOKEN)).toBe(`https://api.example.com/api/email/unsubscribe/${TOKEN}`);
    expect(unsubscribeUrl('https://api.example.com/', TOKEN)).toBe(`https://api.example.com/api/email/unsubscribe/${TOKEN}`);
  });
});

describe('parseMailbox', () => {
  it('takes the address out of a display-name form and lowercases it', () => {
    expect(parseMailbox('"Jo Smith" <Jo@Example.com>')).toBe('jo@example.com');
    expect(parseMailbox('Jo Smith <jo@example.com>')).toBe('jo@example.com');
    expect(parseMailbox('  <jo@example.com> ')).toBe('jo@example.com');
  });

  it('accepts a bare address', () => {
    expect(parseMailbox('Jo@Example.com')).toBe('jo@example.com');
    expect(parseMailbox(' jo+tag@example.co.uk ')).toBe('jo+tag@example.co.uk');
  });

  it('uses the angle-bracket address even when the display name contains one', () => {
    expect(parseMailbox('"x <evil@example.com>" <jo@example.com>')).toBe('jo@example.com');
  });

  it('returns null for junk', () => {
    for (const junk of ['', '   ', 'not an address', 'jo@', '@example.com', 'jo@example', 'a@b.com, c@d.com', 'jo smith@example.com', '<>', 'jo@@example.com']) {
      expect(parseMailbox(junk), junk).toBeNull();
    }
  });
});

describe('tokenFromRecipients', () => {
  it('finds the token in a display-name, mixed-case recipient', () => {
    expect(tokenFromRecipients([`Sam <SAM+${TOKEN}@Reply.RethinkRE.team>`], DOMAIN)).toEqual({ token: TOKEN, unsubscribe: false });
  });

  it('flags the unsubscribe mailbox', () => {
    expect(tokenFromRecipients([`unsubscribe+${TOKEN}@${DOMAIN}`], DOMAIN)).toEqual({ token: TOKEN, unsubscribe: true });
  });

  it('ignores recipients that are not ours and finds ours among several', () => {
    expect(tokenFromRecipients(['bob@example.com', `sam+${TOKEN}@${DOMAIN}`], DOMAIN)).toEqual({ token: TOKEN, unsubscribe: false });
  });

  it('is null at another domain, including a sub- or parent domain', () => {
    expect(tokenFromRecipients([`sam+${TOKEN}@other.example.com`], DOMAIN)).toBeNull();
    expect(tokenFromRecipients([`sam+${TOKEN}@x.${DOMAIN}`], DOMAIN)).toBeNull();
    expect(tokenFromRecipients([`sam+${TOKEN}@rethinkre.team`], DOMAIN)).toBeNull();
  });

  it('is null unless the local part is exactly sam+ or unsubscribe+ and 26 base32 characters', () => {
    const bad = [
      `sam@${DOMAIN}`,
      `sam+${TOKEN.slice(1)}@${DOMAIN}`, // 25
      `sam+${TOKEN}a@${DOMAIN}`, // 27
      `sam+${'1'.repeat(26)}@${DOMAIN}`, // 1 is not base32
      `sam+${'8'.repeat(26)}@${DOMAIN}`,
      `sam+${TOKEN.slice(0, 25)}-@${DOMAIN}`,
      `sam+${TOKEN}+x@${DOMAIN}`,
      `bob+${TOKEN}@${DOMAIN}`,
      `xsam+${TOKEN}@${DOMAIN}`,
    ];
    for (const address of bad) expect(tokenFromRecipients([address], DOMAIN), address).toBeNull();
  });

  it('is null for an empty list or junk', () => {
    expect(tokenFromRecipients([], DOMAIN)).toBeNull();
    expect(tokenFromRecipients(['', 'junk'], DOMAIN)).toBeNull();
  });

  it('compares the configured domain case-insensitively', () => {
    expect(tokenFromRecipients([`sam+${TOKEN}@reply.rethinkre.team`], 'Reply.RethinkRE.team')).toEqual({ token: TOKEN, unsubscribe: false });
  });
});
