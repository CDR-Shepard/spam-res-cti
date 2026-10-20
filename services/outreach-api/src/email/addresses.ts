/**
 * The mailboxes Sam's email channel owns, and how to read one back out of a header.
 *
 * Every conversation has a token (26 lowercase base32 characters, see conversations/store.ts).
 * It rides in the plus-addressed local part of the reply address (`sam+<token>@<replyDomain>`) so an
 * inbound reply finds its conversation from the recipient alone, with no lookup by sender: a seller
 * writing from a second address, or a forward, still lands on the right timeline.
 *
 * Pure: no I/O, no clock, no logging. The recipient is seller-controlled input (a forwarded or
 * hand-edited address), so `tokenFromRecipients` accepts only the exact shape we mint and nothing
 * looser: the wrong token shape or the wrong domain is "not ours", never a near-match.
 */

/** 26 characters of lowercase base32 (a-z, 2-7): what newConversationToken() mints. */
const TOKEN_SOURCE = '[a-z2-7]{26}';
const LOCAL_PART = new RegExp(`^(sam|unsubscribe)\\+(${TOKEN_SOURCE})$`);

/** One address, no display name, no comma list: what is left once a mailbox is unwrapped. */
const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/;
const ADDRESS_MAX = 254;

export function replyAddress(token: string, domain: string): string {
  return `sam+${token}@${domain}`;
}

export function unsubscribeMailto(token: string, domain: string): string {
  return `unsubscribe+${token}@${domain}`;
}

/** The one-click unsubscribe page, which lives on the public API origin (a trailing slash is tolerated). */
export function unsubscribeUrl(apiPublicUrl: string, token: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/api/email/unsubscribe/${token}`;
}

/**
 * `"Jo Smith" <Jo@Example.com>` → `jo@example.com`. The last `<…>` wins (a display name may itself
 * contain angle brackets); with none, the whole string must be a bare address. Anything else
 * (empty, several addresses, a name with no address) is null.
 */
export function parseMailbox(raw: string): string | null {
  const trimmed = raw.trim();
  const angled = /<([^<>]*)>\s*$/.exec(trimmed);
  const candidate = (angled ? angled[1]! : trimmed).trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > ADDRESS_MAX) return null;
  return ADDRESS.test(candidate) ? candidate : null;
}

/**
 * The conversation token addressed by any of these recipients, and whether it was the unsubscribe
 * mailbox. The domain must equal ours exactly (a sub- or parent domain is not ours); the local part
 * must be exactly `sam+<token>` or `unsubscribe+<token>`. First match wins.
 */
export function tokenFromRecipients(
  addresses: readonly string[],
  domain: string,
): { token: string; unsubscribe: boolean } | null {
  const ourDomain = domain.trim().toLowerCase();
  for (const raw of addresses) {
    const mailbox = parseMailbox(raw);
    if (mailbox === null) continue;
    const at = mailbox.lastIndexOf('@');
    if (mailbox.slice(at + 1) !== ourDomain) continue;
    const match = LOCAL_PART.exec(mailbox.slice(0, at));
    if (match) return { token: match[2]!, unsubscribe: match[1] === 'unsubscribe' };
  }
  return null;
}
