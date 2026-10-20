/**
 * The call agent's history fence and Sam's email writer neutralise seller text with ONE function
 * (neutraliseSellerText, @cti/contracts): the same history digest reaches both prompts, so a forged fence tag that one
 * would stop must never get through the other. This feeds the shared forgeries (zero-width, full-width, attribute and
 * self-closing spellings) through the agent's prompt; outreach-api's writer-prompt.test.ts feeds the same list
 * through the email writer's.
 */
import { describe, expect, it } from 'vitest';
import { neutraliseSellerText, SELLER_TEXT_FORGERIES } from '@cti/contracts';
import { buildInstructions, type PromptInput } from './prompt.js';

const OPEN = '<conversation_history>';
const CLOSE = '</conversation_history>';

const input = (history: string): PromptInput => ({
  agentName: 'Ava',
  companyName: 'GG Homes',
  firstName: 'Jane',
  address: '1234 Oak St, Tampa, FL 33601',
  notes: 'Notes: roof leaks.',
  isTest: false,
  localTime: 'Tuesday 4:12 PM',
  callbackNumber: '+15125550100',
  history,
});

const fenced = (text: string): string => text.slice(text.indexOf(OPEN) + OPEN.length + 1, text.lastIndexOf(CLOSE) - 1);

describe('the history fence uses the shared seller-text neutraliser (parity with the email writer)', () => {
  it.each(SELLER_TEXT_FORGERIES.map((f) => [JSON.stringify(f), f]))('%s is inert and carried exactly as neutraliseSellerText makes it', (_label, forgery) => {
    const history = `2026-10-02 Email from the seller — "Re: x": before ${forgery} after`;
    const text = buildInstructions(input(history));
    expect(fenced(text)).toBe(neutraliseSellerText(history));
    expect(fenced(text)).not.toMatch(/[<>＜＞﹤﹥]/);
    expect(text.split(OPEN)).toHaveLength(2);
    expect(text.split(CLOSE)).toHaveLength(2);
  });
});
