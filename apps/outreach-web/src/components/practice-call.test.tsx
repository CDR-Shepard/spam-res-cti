import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CallPlanCard, EditableCallPlan } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { PracticeCall } from './practice-call';

afterEach(() => vi.unstubAllGlobals());

const ENROLLMENT = '22222222-2222-4222-8222-222222222222';
const CALL = '99999999-9999-4999-8999-999999999999';
const PRACTICE = `POST /api/call-plans/${ENROLLMENT}/practice`;
const AVAILABILITY = 'GET /api/ai-calls/availability';
const HINT = "You'll hear exactly what the seller would hear. Nothing is written to Salesforce.";

const PLAN: EditableCallPlan = {
  situationSummary: 'Inherited the house.',
  sellingSignals: [],
  opener: 'Ask about the house.',
  goals: [
    { goal: 'still_selling', known: null, approach: 'Ask' },
    { goal: 'timeline', known: null, approach: 'Ask' },
    { goal: 'condition', known: null, approach: 'Ask' },
    { goal: 'price_expectations', known: null, approach: 'Ask' },
  ],
  talkingPoints: [],
  questions: [],
  avoid: [],
  bestTimeToCall: { window: 'any', reason: 'Any time' },
  reengagement: null,
  stillToLearn: [],
};
const card = (over: Partial<CallPlanCard> = {}): CallPlanCard => ({
  enrollmentId: ENROLLMENT,
  sfObject: 'Lead',
  sfRecordId: '00Q000000000001AAA',
  recordUrl: null,
  name: 'Jane Seller',
  ownerName: 'Rep One',
  enrollmentStatus: 'active',
  callStage: 'approved',
  consent: 'yes',
  warnings: [],
  research: null,
  plan: { version: 3, status: 'approved', source: 'model', plan: PLAN, createdAt: '2026-10-05T10:00:00.000Z', decidedAt: null, dncFlagDismissed: false, dncFlagDismissedBy: null, dncFlagDismissedAt: null },
  prepareError: null,
  mayDecide: true,
  ...over,
});
const numbers = { available: true, testNumbers: ['+15125550111', '+12125550100'] };

describe('PracticeCall', () => {
  it('is hidden for a rep, and asks for nothing', () => {
    const calls = stubApi({ [AVAILABILITY]: numbers });
    const { container } = renderWithProviders(<PracticeCall card={card()} />);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('is hidden on a card with no plan', () => {
    stubApi({ [AVAILABILITY]: numbers });
    const { container } = renderWithProviders(<PracticeCall card={card({ plan: null, callStage: 'research' })} />, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('an admin picks a test number and POSTs the plan version and the number; then "Ringing your phone…"', async () => {
    const calls = stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'placed', aiCallId: CALL } });
    renderWithProviders(<PracticeCall card={card()} />, { isAdmin: true });
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Test number'), '+12125550100');
    await userEvent.click(screen.getByRole('button', { name: 'Practice call to my phone' }));
    expect(await screen.findByText('Ringing your phone…')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: 3, to: '+12125550100' });
  });

  describe('final review: the status follows the call once it was placed', () => {
    const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
    const LIST = `GET /api/campaigns/${CAMPAIGN}/practice-calls`;
    const item = (callStatus: string, outcome: string | null) => ({
      id: '44444444-4444-4444-8444-444444444444', enrollmentId: ENROLLMENT, name: 'Jane Seller', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', planVersion: 3,
      aiCallId: CALL, callStatus, outcome, summary: null, appointment: null, result: { result: 'placed', aiCallId: CALL }, createdAt: '2026-10-06T16:00:00.000Z',
    });

    it('leaves "Ringing your phone…" once the call has ended, and says how it went', async () => {
      stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'placed', aiCallId: CALL }, [LIST]: { items: [item('completed', 'not_interested')] } });
      renderWithProviders(<PracticeCall card={card()} campaignId={CAMPAIGN} />, { isAdmin: true });
      await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
      expect(await screen.findByText('Practice call ended: Not interested.')).toBeInTheDocument();
      expect(screen.queryByText('Ringing your phone…')).not.toBeInTheDocument();
    });

    it('says "On the call…" while it is in progress', async () => {
      stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'placed', aiCallId: CALL }, [LIST]: { items: [item('in_progress', null)] } });
      renderWithProviders(<PracticeCall card={card()} campaignId={CAMPAIGN} />, { isAdmin: true });
      await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
      expect(await screen.findByText('On the call…')).toBeInTheDocument();
    });
  });

  it('a proposed plan can be practised too', async () => {
    const calls = stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'placed', aiCallId: CALL } });
    renderWithProviders(<PracticeCall card={card({ callStage: 'review', plan: { ...card().plan!, status: 'proposed', version: 1 } })} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ version: 1, to: '+15125550111' }));
  });

  it('a 409 PLAN_TEXT_REJECTED shows the server\'s words', async () => {
    const words = "Can't practice: the voice agent can't be given this plan's text. Edit it first. the opener: a price or an amount.";
    stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: respond(409, { error: words, code: 'PLAN_TEXT_REJECTED', details: { words: ['the opener: a price or an amount'] } }) });
    renderWithProviders(<PracticeCall card={card()} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
  });

  it('a blocked answer says why in words', async () => {
    stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'blocked', reason: 'not_admin_for_test', aiCallId: CALL } });
    renderWithProviders(<PracticeCall card={card()} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
    expect(await screen.findByText('Not placed: test calls are for admins, to a number in AI_VOICE_TEST_NUMBERS')).toBeInTheDocument();
  });

  it('cti-api refusing the plan text says so', async () => {
    stubApi({ [AVAILABILITY]: numbers, [PRACTICE]: { result: 'failed', reason: 'plan_rejected', aiCallId: null } });
    renderWithProviders(<PracticeCall card={card()} />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Practice call to my phone' }));
    expect(await screen.findByText("Not placed: the voice agent refused the plan's text")).toBeInTheDocument();
  });

  it('with no test numbers it says where to add one, and offers no button', async () => {
    stubApi({ [AVAILABILITY]: { available: true, testNumbers: [] } });
    renderWithProviders(<PracticeCall card={card()} />, { isAdmin: true });
    expect(await screen.findByText(/No test numbers are set/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Practice call to my phone' })).not.toBeInTheDocument();
  });
});
