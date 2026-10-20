/**
 * GET and POST /api/email/unsubscribe/:token: the page behind the unsubscribe link in every email Sam sends,
 * and the endpoint a mailbox provider's "Unsubscribe" button posts to (RFC 8058 one-click). Public, no
 * session: the token in the URL (128 random bits, minted with the conversation) is the credential.
 *
 *  - GET shows a button and changes NOTHING. Mail scanners and link previewers fetch every URL in a message;
 *    if a GET stopped the seller, a scanner would unsubscribe people who never asked.
 *  - POST stops the seller for good (`stopSeller` with `opted_out`: every Sam channel, every record with the
 *    same address, the address on the suppression list) and shows the confirmation. Repeating it is fine.
 *  - The body is ignored and any content type is accepted: one-click senders post `List-Unsubscribe=One-Click`
 *    as urlencoded, but some send multipart or nothing, and a refusal here is a seller who keeps getting mail.
 *    The parser is plugin-scoped (Fastify scopes a content-type parser to its plugin) and bounded at 8 KB.
 *  - The token is checked for its exact shape before anything reads the database, so a malformed one costs
 *    nothing and an unknown one looks the same as a malformed one: a 404 page.
 *  - The pages show nothing about the seller (no name, no address, not even the token), carry no script, are
 *    never cached, indexed or framed, and send no Referer (the token is in the URL). The company name is
 *    the tenant's, and is escaped like any text.
 *
 * Logs carry the conversation id only: never the token (the request log's URL is redacted, see
 * http/log-serializers.ts), an address, a name, or the text of a failure (a database error can quote a
 * value). A failed stop logs the error's class name and code, nothing else.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '@cti/db';
import { dispatchAlert, type AlertEvent } from '../alerts.js';
import { raiseSharedAddressAlert, sharedAddressCollector } from '../conversations/shared-address.js';
import { findConversationByToken, stopSeller } from '../conversations/store.js';
import { describeError } from '../email/errors.js';
import { escapeHtml, possessive } from '../email/render.js';

/** Mail clients post a few bytes; this bounds what an unauthenticated caller can make us read. */
export const UNSUBSCRIBE_BODY_LIMIT_BYTES = 8 * 1024;

/** What `newConversationToken()` mints: 26 characters of lowercase base32. */
const TOKEN_SHAPE = /^[a-z2-7]{26}$/;

export interface EmailUnsubscribeDeps {
  db: Db;
  /** The tenant's name as the emails say it ("GG Homes"). */
  companyName: string;
  now?: () => Date;
  /** Where the seller_needs_person alert goes (a stop at an address many records share); the shared dispatcher when absent. */
  alert?: (event: AlertEvent) => Promise<void>;
}

/** Sent with every page; nothing here may be loosened without thinking about the token in the URL. */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const STYLE = `
body{margin:0;padding:48px 20px;background:#f6f6f4;color:#1f2328;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 28px;background:#fff;border:1px solid #e3e3df;border-radius:10px}
h1{margin:0 0 16px;font-size:22px}
p{margin:0 0 20px}
button{padding:10px 20px;border:0;border-radius:6px;background:#1f2328;color:#fff;font:inherit;cursor:pointer}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`;
}

function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.code(status).headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(html);
}

/** The assistant's introduction as the pages say it: "Sam, GG Homes' AI assistant". */
function introduction(companyName: string): string {
  return `Sam, ${escapeHtml(possessive(companyName))} AI assistant`;
}

function confirmPage(companyName: string): string {
  return page(
    'Unsubscribe',
    `<p>Click the button to stop all calls, texts and emails from ${introduction(companyName)}.</p>
<form method="post">
<button type="submit">Unsubscribe</button>
</form>`,
  );
}

function donePage(companyName: string): string {
  return page('Unsubscribed', `<p>You're unsubscribed. ${introduction(companyName)}, won't call, text or email you again.</p>`);
}

const notValidPage = (): string => page('Link not valid', '<p>This link is not valid.</p>');

/** Shown for a failed stop; it offers the same button again, because the seller's next click is the retry. */
const failedPage = (): string =>
  page(
    'Something went wrong',
    `<p>Something went wrong. Please try again in a minute.</p>
<form method="post">
<button type="submit">Unsubscribe</button>
</form>`,
  );

export async function registerEmailUnsubscribeRoutes(app: FastifyInstance, deps: EmailUnsubscribeDeps): Promise<void> {
  // Any content type, any body, read as a string (so the limit applies) and ignored. This replaces Fastify's
  // JSON parser too: a one-click sender's malformed JSON must not turn into a 400 that leaves the seller subscribed.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/x-www-form-urlencoded', '*'], { parseAs: 'string', bodyLimit: UNSUBSCRIBE_BODY_LIMIT_BYTES }, (_req, _body, done) => done(null, undefined));

  /** The conversation behind a well-formed token, or null (malformed, or unknown). A malformed token never reaches the database. */
  async function conversationFor(token: string) {
    return TOKEN_SHAPE.test(token) ? findConversationByToken(deps.db, token) : null;
  }

  app.get<{ Params: { token: string } }>('/email/unsubscribe/:token', async (req, reply) => {
    const conversation = await conversationFor(req.params.token);
    if (!conversation) return sendPage(reply, 404, notValidPage());
    return sendPage(reply, 200, confirmPage(deps.companyName));
  });

  app.post<{ Params: { token: string } }>('/email/unsubscribe/:token', async (req, reply) => {
    const conversation = await conversationFor(req.params.token);
    if (!conversation) return sendPage(reply, 404, notValidPage());
    const shared = sharedAddressCollector();
    try {
      await stopSeller(deps.db, { conversationId: conversation.id, reason: 'opted_out', now: deps.now?.() ?? new Date(), onSharedAddress: shared.onSharedAddress });
    } catch (err) {
      req.log.error({ conversationId: conversation.id, requestId: req.id, ...describeError(err) }, 'unsubscribe failed');
      return sendPage(reply, 500, failedPage());
    }
    req.log.info({ conversationId: conversation.id, requestId: req.id }, 'seller unsubscribed');
    // stopSeller ran its own transaction, so the stop has committed: a stop held back by a shared address may page now.
    const alert = deps.alert ?? ((event: AlertEvent) => dispatchAlert(req.log, event));
    for (const notice of shared.notices()) await raiseSharedAddressAlert({ alert, log: req.log }, notice);
    return sendPage(reply, 200, donePage(deps.companyName));
  });
}
