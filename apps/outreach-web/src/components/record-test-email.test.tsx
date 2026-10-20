import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordTestEmailPreview } from '@cti/contracts';
import { renderWithProviders } from '../test/render';
import { TEST_ID } from '../test/record-test-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { RecordTestEmail } from './record-test-email';

afterEach(() => vi.unstubAllGlobals());

const ROUTE = `POST /api/record-tests/${TEST_ID}/email-preview`;
const FOOTER = '—\nSam\n\nGG Homes · 18872 MacArthur Blvd #220, Irvine, CA 92612\nTo stop hearing from Sam, unsubscribe here';
const DRAFT: RecordTestEmailPreview = { subject: 'Your home on Oak Street', body: 'Hi Pat,\n\nIs the house on Oak Street still for sale?', footer: FOOTER, issues: [] };

describe('RecordTestEmail', () => {
  it('says nothing is sent before anything is asked', () => {
    const calls = stubApi({});
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    expect(screen.getByRole('region', { name: "Sam's first email" })).toHaveTextContent('Nothing is sent.');
    expect(screen.getByRole('button', { name: "Preview Sam's email" })).toBeEnabled();
    expect(calls).toEqual([]);
  });

  it('shows the subject, the body and the footer the seller would see, and that nothing was sent', async () => {
    const calls = stubApi({ [ROUTE]: DRAFT });
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: "Preview Sam's email" }));
    const draft = await screen.findByRole('article', { name: "Sam's draft" });
    expect(screen.getByRole('status')).toHaveTextContent('Nothing was sent.');
    expect(draft).toHaveTextContent('Subject: Your home on Oak Street');
    expect(within(draft).getByRole('group', { name: 'Body' }).textContent).toBe(DRAFT.body);
    expect(within(draft).getByRole('group', { name: 'Footer' }).textContent).toBe(FOOTER);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('Write another asks Sam again and shows the new draft', async () => {
    stubApi({ [ROUTE]: DRAFT });
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: "Preview Sam's email" }));
    await screen.findByRole('article', { name: "Sam's draft" });
    const again = stubApi({ [ROUTE]: { ...DRAFT, subject: 'Still thinking about Oak Street?' } });
    await userEvent.click(screen.getByRole('button', { name: 'Write another' }));
    expect(await screen.findByText('Still thinking about Oak Street?')).toBeInTheDocument();
    expect(screen.queryByText(DRAFT.subject)).not.toBeInTheDocument();
    expect(again.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a draft Send would refuse as written lists why', async () => {
    const issues = ['The subject must be one line.', 'The body has a price or dollar amount; Sam does not quote prices or offers.'];
    stubApi({ [ROUTE]: { ...DRAFT, issues } });
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: "Preview Sam's email" }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A real send would refuse this draft as written:');
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(issues);
  });

  it('a refusal on the first try shows in words, no draft, and the button still offers the first draft', async () => {
    stubApi({ [ROUTE]: respond(409, { error: "Today's AI budget is spent. Raise it in Settings or try again tomorrow.", code: 'AI_BUDGET_SPENT' }) });
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: "Preview Sam's email" }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Today's AI budget is spent.");
    expect(screen.queryByRole('article', { name: "Sam's draft" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Preview Sam's email" })).toBeEnabled();
  });

  it('a refusal of Write another keeps the draft already written', async () => {
    stubApi({ [ROUTE]: DRAFT });
    renderWithProviders(<RecordTestEmail testId={TEST_ID} />, { isAdmin: true });
    await userEvent.click(screen.getByRole('button', { name: "Preview Sam's email" }));
    await screen.findByRole('article', { name: "Sam's draft" });
    stubApi({ [ROUTE]: respond(502, { error: "Sam's draft did not come back. Try again in a minute.", code: 'MODEL_ERROR' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Write another' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Sam's draft did not come back.");
    expect(screen.getByRole('article', { name: "Sam's draft" })).toHaveTextContent(DRAFT.subject);
    expect(screen.getByRole('button', { name: 'Write another' })).toBeEnabled();
  });
});
