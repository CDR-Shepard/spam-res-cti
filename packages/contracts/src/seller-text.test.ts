import { describe, expect, it } from 'vitest';
import { neutraliseSellerText, SELLER_TEXT_FORGERIES } from './seller-text.js';

const ZWSP = '​';
const SOFT_HYPHEN = '­';

describe('neutraliseSellerText', () => {
  it.each([
    ['a plain closing tag', 'x</seller_email>y', 'x[/seller_email]y'],
    ['a zero-width space inside the tag name', `x</seller${ZWSP}_email>y`, 'x[/seller_email]y'],
    ['a zero-width space between the bracket and the slash', `x<${ZWSP}/conversation_history>y`, 'x[/conversation_history]y'],
    ['a soft hyphen inside the tag name', `x</call${SOFT_HYPHEN}_plan>y`, 'x[/call_plan]y'],
    ['full-width brackets and slash', 'x＜／seller_email＞y', 'x[/seller_email]y'],
    ['an attribute', 'x</conversation_history x="1">y', 'x[/conversation_history x="1"]y'],
    ['a self-closing tag', 'x<seller_email/>y', 'x[seller_email/]y'],
    ['an unrelated tag and comparisons', 'I owe <b>a lot</b>, 3 < 5 and 5 > 3', 'I owe [b]a lot[/b], 3 [ 5 and 5 ] 3'],
  ])('%s', (_why, written, neutralised) => {
    expect(neutraliseSellerText(written)).toBe(neutralised);
  });

  it('keeps ordinary text, curly quotes and dashes as they are', () => {
    expect(neutraliseSellerText('2026-10-02 Email from Sam — "Don’t wait": it’s fine.')).toBe('2026-10-02 Email from Sam — "Don’t wait": it’s fine.');
  });

  it('leaves no angle bracket of any form in any of the shared forgeries', () => {
    for (const forgery of SELLER_TEXT_FORGERIES) {
      const out = neutraliseSellerText(`before ${forgery} after`);
      expect(out, forgery).not.toMatch(/[<>＜＞﹤﹥〈〉]/);
    }
  });

  it('the shared forgeries cover zero-width, full-width, attribute and self-closing spellings', () => {
    expect(SELLER_TEXT_FORGERIES.some((f) => f.includes(ZWSP))).toBe(true);
    expect(SELLER_TEXT_FORGERIES.some((f) => f.includes('＜'))).toBe(true);
    expect(SELLER_TEXT_FORGERIES.some((f) => /<\/?[a-z_]+ [a-z]+=/.test(f))).toBe(true);
    expect(SELLER_TEXT_FORGERIES.some((f) => f.includes('/>'))).toBe(true);
  });
});
