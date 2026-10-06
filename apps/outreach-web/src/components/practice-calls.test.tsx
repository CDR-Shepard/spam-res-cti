import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BookedAppointment, PracticeCall } from '@cti/contracts';
import { appointmentWords } from '@/lib/call-words';
import { formatDateTime } from '@/lib/outreach-words';
import { renderWithProviders } from '../test/render';
import { CAMPAIGN_ID } from '../test/outreach-fixtures';
import { stubApi } from '../test/stub-api';
import { PracticeCalls } from './practice-calls';

afterEach(() => vi.unstubAllGlobals());

const LIST = `GET /api/campaigns/${CAMPAIGN_ID}/practice-calls`;
const CALL = '99999999-9999-4999-8999-999999999999';
const BOOKED: BookedAppointment = {
  slotId: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: false, note: '', bookedAt: '2026-10-06T22:05:00.000Z',
};
const practice = (n: number, over: Partial<PracticeCall> = {}): PracticeCall => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  name: `Lead ${n}`,
  sfObject: 'Lead',
  sfRecordId: `00Q00000000000${n}AAA`,
  planVersion: 1,
  aiCallId: null,
  callStatus: null,
  outcome: null,
  summary: null,
  appointment: null,
  result: null,
  createdAt: '2026-10-06T22:00:00.000Z',
  ...over,
});

describe('PracticeCalls', () => {
  it('is hidden when there are none', async () => {
    const calls = stubApi({ [LIST]: { items: [] } });
    const { container } = renderWithProviders(<PracticeCalls campaignId={CAMPAIGN_ID} />, { isAdmin: true });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each call: the time, the lead, the outcome and "would have booked …", and opens the transcript', async () => {
    stubApi({
      [LIST]: { items: [practice(1, { aiCallId: CALL, callStatus: 'completed', outcome: 'appointment_set', summary: 'Booked a call.', appointment: BOOKED, result: { result: 'placed', aiCallId: CALL } })] },
      [`GET /api/ai-calls/${CALL}/transcript`]: { aiCallId: CALL, lines: [{ role: 'agent', text: 'Hi, this is an AI assistant.', at: null }] },
    });
    renderWithProviders(<PracticeCalls campaignId={CAMPAIGN_ID} />, { isAdmin: true });
    expect(await screen.findByRole('heading', { name: 'Practice calls' })).toBeInTheDocument();
    const row = within(screen.getByText('Lead 1').closest('tr')!);
    expect(row.getByText(formatDateTime('2026-10-06T22:00:00.000Z'))).toBeInTheDocument();
    expect(row.getByText('Appointment set')).toBeInTheDocument();
    expect(row.getByText(`Would have booked: ${appointmentWords(BOOKED)}`)).toBeInTheDocument();
    await userEvent.click(row.getByRole('button', { name: 'Transcript' }));
    expect(await screen.findByText('Hi, this is an AI assistant.')).toBeInTheDocument();
  });

  it('a call that was not placed says why', async () => {
    stubApi({ [LIST]: { items: [practice(2, { result: { result: 'blocked', reason: 'not_admin_for_test', aiCallId: CALL }, aiCallId: CALL, callStatus: 'blocked' })] } });
    renderWithProviders(<PracticeCalls campaignId={CAMPAIGN_ID} />, { isAdmin: true });
    expect(await screen.findByText('Not placed: test calls are for admins, to a number in AI_VOICE_TEST_NUMBERS')).toBeInTheDocument();
  });
});
