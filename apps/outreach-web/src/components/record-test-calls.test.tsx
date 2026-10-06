import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { AI_CALL_ID, CALL_ID, recordTestCall } from '../test/record-test-fixtures';
import { stubApi } from '../test/stub-api';
import { isLiveCall, RecordTestCalls } from './record-test-calls';

afterEach(() => vi.unstubAllGlobals());

const booked = recordTestCall({
  qualification: { motivation: 'Moving to Ohio', asking_price: 'About 300k' },
  callbackAt: '2026-10-08T20:00:00.000Z',
  appointment: {
    slotId: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:30:00.000Z',
    specialistSfUserId: '005000000000001AAA', addressConfirmed: false, note: '', bookedAt: '2026-10-06T17:06:00.000Z',
  },
});
const NOW = Date.parse('2026-10-06T17:06:00.000Z');

describe('RecordTestCalls', () => {
  it('a finished call: outcome, length, summary, what it learned, the callback and what it would have booked', () => {
    stubApi({});
    renderWithProviders(<RecordTestCalls calls={[booked]} />, { isAdmin: true });
    expect(screen.getByText(/Your phone \(\+15125550111\)/)).toBeInTheDocument();
    expect(screen.getByText('Appointment set · 2:05')).toBeInTheDocument();
    expect(screen.getByText('She wants a call about the roof.')).toBeInTheDocument();
    const learned = screen.getByRole('list', { name: 'What it learned' });
    expect(learned).toHaveTextContent('Motivation: Moving to Ohio');
    expect(learned).toHaveTextContent('Asking price: About 300k');
    expect(screen.getByText(/^Asked for a call back: /)).toBeInTheDocument();
    expect(screen.getByText('Would have booked: Phone call Wed Oct 7, 11:00 AM PT')).toBeInTheDocument();
  });

  it('newest first; a refusal and a lost answer say so', () => {
    stubApi({});
    const older = recordTestCall({ id: '99999999-9999-4999-8999-999999999991', createdAt: '2026-10-06T16:00:00.000Z', result: { result: 'blocked', reason: 'no_caller_id', aiCallId: AI_CALL_ID }, callStatus: 'blocked', outcome: 'blocked' });
    const lost = recordTestCall({ id: '99999999-9999-4999-8999-999999999992', mode: 'browser', toE164: null, createdAt: '2026-10-06T15:00:00.000Z', result: null, aiCallId: null, callStatus: null, outcome: null });
    renderWithProviders(<RecordTestCalls calls={[lost, older, booked]} />, { isAdmin: true });
    const cards = screen.getAllByRole('article');
    expect(cards[0]).toHaveTextContent('Your phone');
    expect(cards[1]).toHaveTextContent('Not placed: no AI caller ID number is free');
    expect(cards[2]).toHaveTextContent('This browser');
    expect(cards[2]).toHaveTextContent('No answer from the AI calling service');
  });

  it('the Transcript button opens the transcript', async () => {
    stubApi({ [`GET /api/ai-calls/${AI_CALL_ID}/transcript`]: { aiCallId: AI_CALL_ID, lines: [{ role: 'agent', text: 'Hi, this is the AI assistant.', at: null }] } });
    renderWithProviders(<RecordTestCalls calls={[booked]} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: 'Transcript' }));
    expect(await screen.findByText('Hi, this is the AI assistant.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide transcript' })).toBeInTheDocument();
  });

  it('shows the live status and how long it has been going', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    stubApi({});
    renderWithProviders(<RecordTestCalls calls={[recordTestCall({ callStatus: 'ringing', outcome: null, durationSeconds: null, summary: null })]} />, { isAdmin: true });
    expect(screen.getByText('Ringing · 1:00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Transcript' })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('a call stuck in progress past the longest call reads as status unknown', () => {
    vi.useFakeTimers({ now: NOW + 31 * 60_000, toFake: ['Date'] });
    stubApi({});
    renderWithProviders(<RecordTestCalls calls={[recordTestCall({ callStatus: 'in_progress', outcome: null, durationSeconds: null, summary: null })]} />, { isAdmin: true });
    expect(screen.getByText('Status unknown — check the transcript later')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('isLiveCall', () => {
  it.each([
    ['ringing', recordTestCall({ callStatus: 'ringing' }), true],
    ['completed', recordTestCall({ callStatus: 'completed' }), false],
    ['in progress for 20 min', recordTestCall({ callStatus: 'in_progress', createdAt: '2026-10-06T16:46:00.000Z' }), true],
    ['in progress for over 30 min (stuck: no more polling)', recordTestCall({ callStatus: 'in_progress', createdAt: '2026-10-06T16:35:00.000Z' }), false],
    ['placed, not joined yet', recordTestCall({ callStatus: null }), true],
    ['placed, not joined for over 30 min', recordTestCall({ callStatus: null, createdAt: '2026-10-06T16:00:00.000Z' }), false],
    ['no answer yet, under 2 min', recordTestCall({ id: CALL_ID, result: null, aiCallId: null, callStatus: null }), true],
    ['no answer, over 2 min', recordTestCall({ result: null, aiCallId: null, callStatus: null, createdAt: '2026-10-06T17:00:00.000Z' }), false],
    ['refused', recordTestCall({ result: { result: 'failed', reason: 'twilio_error', aiCallId: null }, callStatus: null }), false],
  ])('%s', (_name, call, live) => {
    expect(isLiveCall(call, NOW)).toBe(live);
  });
});
