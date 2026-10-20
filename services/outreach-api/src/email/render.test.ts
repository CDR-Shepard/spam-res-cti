import { describe, expect, it } from 'vitest';
import { escapeHtml, possessive, renderEmail, unsubscribeFooterLine } from './render.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz';
const URL = `https://api.example.com/api/email/unsubscribe/${TOKEN}`;
const base = {
  body: 'Hello Jo,\n\nI saw your home on Elm Street.\nWould a short chat work?',
  token: TOKEN,
  apiPublicUrl: 'https://api.example.com',
  replyDomain: 'reply.rethinkre.team',
  postalAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612',
  companyName: 'GG Homes',
  inReplyTo: null,
  references: null,
};

const FOOTER = [
  '—',
  'Sam',
  '',
  'GG Homes · 18872 MacArthur Blvd #220, Irvine, CA 92612',
  `To stop hearing from Sam, unsubscribe here: ${URL}`,
].join('\n');

describe('renderEmail', () => {
  it('ends the text with the exact footer, one blank line after the body', () => {
    const { text } = renderEmail(base);
    expect(text).toBe(`${base.body}\n\n${FOOTER}`);
    expect(text.endsWith(FOOTER)).toBe(true);
  });

  it('trims trailing whitespace and normalises CRLF in the body', () => {
    const { text } = renderEmail({ ...base, body: 'Hi\r\n\r\nBye\r\n\r\n  ' });
    expect(text).toBe(`Hi\n\nBye\n\n${FOOTER}`);
  });

  it('renders the body as escaped paragraphs, single newlines as <br>', () => {
    const { html } = renderEmail(base);
    expect(html).toContain('<p>Hello Jo,</p>');
    expect(html).toContain('<p>I saw your home on Elm Street.<br>Would a short chat work?</p>');
  });

  it('escapes HTML in the body, company and postal address', () => {
    const { html } = renderEmail({
      ...base,
      body: '<script>alert(1)</script> & "quoted" \'single\'',
      companyName: 'A<b>&Co',
      postalAddress: '1 "Main" St',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('A&lt;b&gt;&amp;Co');
    expect(html).toContain('1 &quot;Main&quot; St');
  });

  it('puts the unsubscribe URL in one link whose text is "unsubscribe here", and has no other links, images or tracking', () => {
    const { html } = renderEmail(base);
    expect(html).toContain(`<a href="${URL}">unsubscribe here</a>`);
    expect(html.match(/<a\s/g)).toHaveLength(1);
    expect(html).not.toMatch(/<img|<script|<iframe|<link|src=/i);
  });

  it('carries the footer lines in the HTML too', () => {
    const { html } = renderEmail(base);
    expect(html).toContain('<p>—<br>Sam</p>');
    expect(html).toContain('GG Homes · 18872 MacArthur Blvd #220, Irvine, CA 92612');
    expect(html).toContain('To stop hearing from Sam, <a href=');
  });

  it('always sets both List-Unsubscribe headers', () => {
    const { headers } = renderEmail(base);
    expect(headers['List-Unsubscribe']).toBe(`<${URL}>, <mailto:unsubscribe+${TOKEN}@reply.rethinkre.team>`);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('omits In-Reply-To and References when null', () => {
    const { headers } = renderEmail(base);
    expect(Object.keys(headers).sort()).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
  });

  it('sets In-Reply-To and References when given', () => {
    const { headers } = renderEmail({ ...base, inReplyTo: '<a@x.example>', references: '<a@x.example> <b@x.example>' });
    expect(headers['In-Reply-To']).toBe('<a@x.example>');
    expect(headers['References']).toBe('<a@x.example> <b@x.example>');
  });

  it('cannot be made to inject a header line through a threading value', () => {
    const { headers } = renderEmail({ ...base, inReplyTo: '<a@x.example>\r\nBcc: evil@example.com', references: null });
    expect(headers['In-Reply-To']).not.toMatch(/[\r\n]/);
  });
});

describe('possessive', () => {
  it('adds only an apostrophe to a name ending in s or S, otherwise \'s', () => {
    expect(possessive('GG Homes')).toBe("GG Homes'");
    expect(possessive('Jones')).toBe("Jones'");
    expect(possessive('ACME HOMES')).toBe("ACME HOMES'");
    expect(possessive('Acme')).toBe("Acme's");
    expect(possessive('Rethink RE')).toBe("Rethink RE's");
  });

  it('the footer never calls Sam an AI assistant, in either part (owner, 2026-10-20)', () => {
    const { text, html } = renderEmail({ ...base, companyName: 'Acme' });
    expect(text).not.toMatch(/AI assistant/);
    expect(html).not.toMatch(/AI assistant/);
    expect(text).toContain('Acme · 18872 MacArthur Blvd #220');
  });
});

describe('footer building blocks', () => {
  it('uses the same unsubscribe line in the text as the exported builder', () => {
    expect(renderEmail(base).text.endsWith(unsubscribeFooterLine(URL))).toBe(true);
  });

  it('escapes & < > " and \'', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
});
