import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordTestDryRun as DryRun } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { CALL_ID, recordTestCall } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { RecordTestCalls } from './record-test-calls';

afterEach(() => vi.unstubAllGlobals());

const BUTTON = 'What would be written to Salesforce';
const ROUTE = `POST /api/record-tests/calls/${CALL_ID}/dry-run`;
const DRY: DryRun = {
  status: 'ready',
  changes: [
    { label: 'Stage', before: 'Closed Lost', after: 'Appointment Set', kind: 'changed' },
    { label: 'Timeline', before: '30 Days', after: '90 Days', kind: 'kept' },
  ],
  changesText: 'AI call on Tue Oct 6, 3:12 PM PT · Appointment set\nChanged\n- Stage: Closed Lost → Appointment Set',
  chatterText: 'AI call 88888888 · Oct 6, 3:12 PM PT · Appointment set\nCall details: https://outreach.example/test-record?id=x',
  wouldCreate: ['Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden', 'Chatter post'],
  conversion: 'Would convert this Lead (owner Grant Golden, Lead Manager Sam Setter) and write the rest to the new Opportunity. The field list below is the Lead-side approximation.',
  note: null,
};

describe('RecordTestDryRun', () => {
  it('is offered only on a finished call', () => {
    stubApi({});
    renderWithProviders(<RecordTestCalls calls={[recordTestCall({ callStatus: 'in_progress', outcome: null })]} />, { isAdmin: true });
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
  });

  it('asks once, then shows the changes, what it would create, the conversion and both texts; nothing was sent', async () => {
    const calls = stubApi({ [ROUTE]: DRY });
    renderWithProviders(<RecordTestCalls calls={[recordTestCall()]} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(await screen.findByText('Nothing was sent to Salesforce.')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Changed' })).toHaveTextContent('Stage: Closed Lost → Appointment Set');
    expect(screen.getByRole('list', { name: 'Kept as it was in Salesforce' })).toHaveTextContent("Timeline: kept 30 Days (the seller's answer was 90 Days)");
    expect(screen.getByRole('list', { name: 'Would create' })).toHaveTextContent('Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden');
    expect(screen.getByText(DRY.conversion!)).toBeInTheDocument();
    expect(screen.getByLabelText('AI Last Call Changes').textContent).toBe(DRY.changesText);
    expect(screen.getByLabelText('Chatter post').textContent).toBe(DRY.chatterText);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a stored answer opens without asking again', async () => {
    const calls = stubApi({});
    renderWithProviders(<RecordTestCalls calls={[recordTestCall({ dryRun: DRY })]} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(await screen.findByText('Nothing was sent to Salesforce.')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('a call that writes nothing says so', async () => {
    stubApi({ [ROUTE]: { ...DRY, status: 'nothing', changes: [], changesText: null, chatterText: null, wouldCreate: [], conversion: null, note: 'A real call that ended this way writes nothing to Salesforce.' } });
    renderWithProviders(<RecordTestCalls calls={[recordTestCall({ outcome: 'voicemail' })]} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(await screen.findByText('A real call that ended this way writes nothing to Salesforce.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chatter post')).not.toBeInTheDocument();
  });

  it('a refusal shows in words', async () => {
    stubApi({ [ROUTE]: respond(409, { error: "Today's AI budget is spent. Raise it in Settings or try again tomorrow.", code: 'AI_BUDGET_SPENT' }) });
    renderWithProviders(<RecordTestCalls calls={[recordTestCall()]} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Today's AI budget is spent.");
  });
});
