import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WritebackSummary } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { WritebackBadge, WritebackChanges } from './writeback-changes';

afterEach(() => vi.unstubAllGlobals());

const CALL = '99999999-9999-4999-8999-999999999999';
const summary = (over: Partial<WritebackSummary> = {}): WritebackSummary => ({
  status: 'done',
  error: null,
  mayRetry: false,
  convertedOpportunityId: null,
  convertedOpportunityUrl: null,
  changes: [
    { kind: 'converted', label: 'Lead converted to an Opportunity', before: '00Q000000000001AAA', after: '006000000000001AAA' },
    { kind: 'created', label: 'Appointment Event', before: null, after: '00U000000000001AAA' },
    { kind: 'changed', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set' },
    { kind: 'changed', label: 'Timeline', before: null, after: '90 Days' },
    { kind: 'kept', label: 'Rating', before: 'Warm', after: 'Hot' },
    { kind: 'kept', label: 'Next Follow-Up', before: '2026-10-09', after: null },
    { kind: 'not_written', label: 'Loss Reason', before: null, after: 'Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)' },
  ],
  ...over,
});

describe('WritebackChanges', () => {
  it('lists the changes grouped by kind, with old → new', () => {
    stubApi({});
    renderWithProviders(<WritebackChanges summary={summary()} aiCallId={CALL} onRetried={() => {}} />, { isAdmin: true });
    const group = (name: string) => within(screen.getByRole('list', { name }));
    expect(group('Converted').getByText('Lead converted to an Opportunity')).toBeInTheDocument();
    expect(group('Created in Salesforce').getByText('Appointment Event')).toBeInTheDocument();
    expect(group('Changed').getByText('Stage: New Opportunity → Appointment Set')).toBeInTheDocument();
    expect(group('Changed').getByText('Timeline: (blank) → 90 Days')).toBeInTheDocument();
    expect(group('Kept as it was in Salesforce').getByText('Rating: kept Warm (the seller\'s answer was Hot)')).toBeInTheDocument();
    expect(group('Kept as it was in Salesforce').getByText('Next Follow-Up: kept 2026-10-09 (changed in Salesforce since the call)')).toBeInTheDocument();
    expect(group('Not written').getByText('Loss Reason: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('a failed write-back shows its error and a Retry that POSTs and then refetches', async () => {
    const calls = stubApi({ [`POST /api/ai-calls/${CALL}/writeback/retry`]: respond(204) });
    const onRetried = vi.fn();
    renderWithProviders(<WritebackChanges summary={summary({ status: 'failed', error: 'SERVER_UNAVAILABLE', mayRetry: true, changes: [] })} aiCallId={CALL} onRetried={onRetried} />, { isAdmin: true });
    expect(screen.getByText('Last error: SERVER_UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('Nothing was written yet.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRetried).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`/api/ai-calls/${CALL}/writeback/retry`]);
  });

  it('a refused retry says so', async () => {
    stubApi({ [`POST /api/ai-calls/${CALL}/writeback/retry`]: respond(409, { error: 'Only a Salesforce write-back that failed can be sent again.', code: 'NOT_RETRYABLE' }) });
    renderWithProviders(<WritebackChanges summary={summary({ status: 'failed', mayRetry: true })} aiCallId={CALL} onRetried={() => {}} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Salesforce write-back that failed can be sent again.');
  });
});

describe('WritebackBadge', () => {
  it.each([
    ['pending', 'Pending'],
    ['running', 'Writing'],
    ['done', 'Done'],
    ['partial', 'Partial'],
    ['failed', 'Failed'],
    ['skipped', 'Skipped'],
  ] as const)('%s reads %s', (status, words) => {
    renderWithProviders(<WritebackBadge status={status} />);
    expect(screen.getByText(words)).toBeInTheDocument();
  });
});
