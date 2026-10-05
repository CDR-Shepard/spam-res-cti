import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test/render';
import { CAMPAIGN_ID, ENROLLMENT_ID, OTHER_ENROLLMENT_ID, reviewItem } from '../test/outreach-fixtures';
import { respond, stubApi } from '../test/stub-api';
import { ReviewPage } from './review-page';

afterEach(() => vi.unstubAllGlobals());

const twoItems = {
  items: [
    reviewItem(),
    reviewItem({ enrollmentId: OTHER_ENROLLMENT_ID, sfRecordId: '00Q5e00000Abc02', name: 'Sam Seller', ownerName: null, category: 'sold', quote: 'Already sold it last month.' }),
  ],
};

describe('ReviewPage', () => {
  it('lists each flag with the category in words, the quote, the campaign, and the owner', async () => {
    stubApi({ 'GET /api/review': twoItems });
    renderWithRouter(<ReviewPage />);
    const jane = (await screen.findByText('Jane Seller')).closest('tr') as HTMLElement;
    expect(within(jane).getByText('Has an attorney')).toBeInTheDocument();
    expect(within(jane).getByText('“Talk to my lawyer, not me.”')).toBeInTheDocument();
    expect(within(jane).getByRole('link', { name: 'Spring sellers' })).toHaveAttribute('href', `/campaigns/${CAMPAIGN_ID}`);
    expect(within(jane).getByText('Rep One')).toBeInTheDocument();
    const sam = screen.getByText('Sam Seller').closest('tr') as HTMLElement;
    expect(within(sam).getByText('Already sold')).toBeInTheDocument();
  });

  it('dismisses a flag and removes the row', async () => {
    const calls = stubApi({ 'GET /api/review': twoItems, [`POST /api/review/${ENROLLMENT_ID}`]: respond(204) });
    renderWithRouter(<ReviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss flag for Jane Seller' }));
    await waitFor(() => expect(screen.queryByText('Jane Seller')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/review/${ENROLLMENT_ID}`, body: { decision: 'dismiss' } });
    expect(screen.getByText('Sam Seller')).toBeInTheDocument();
  });

  it('confirms do-not-contact only after a dialog that explains it opts the person out of everything', async () => {
    const calls = stubApi({ 'GET /api/review': twoItems, [`POST /api/review/${ENROLLMENT_ID}`]: respond(204) });
    renderWithRouter(<ReviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm do not contact for Jane Seller' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('This opts Jane Seller out of everything');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm do not contact' }));
    await waitFor(() => expect(screen.queryByText('Jane Seller')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/review/${ENROLLMENT_ID}`, body: { decision: 'confirm' } });
  });

  it('explains when someone other than the owner or an admin tries to decide', async () => {
    stubApi({ 'GET /api/review': twoItems, [`POST /api/review/${ENROLLMENT_ID}`]: respond(403, { error: 'Not the owner', code: 'NOT_OWNER' }) });
    renderWithRouter(<ReviewPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss flag for Jane Seller' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Only the record's owner or an admin can decide this one.");
    expect(screen.getByText('Jane Seller')).toBeInTheDocument();
  });

  it('after someone else decided first (409 NOT_IN_REVIEW), says so and reloads the list so the stale row is gone', async () => {
    stubApi({ 'GET /api/review': twoItems });
    renderWithRouter(<ReviewPage />);
    await screen.findByText('Jane Seller');
    // From here on the server's list no longer has Jane, and deciding on her answers 409.
    const calls = stubApi({
      'GET /api/review': { items: [twoItems.items[1]] },
      [`POST /api/review/${ENROLLMENT_ID}`]: respond(409, { error: 'This record is no longer waiting for review', code: 'NOT_IN_REVIEW' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss flag for Jane Seller' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else already decided this one.');
    await waitFor(() => expect(screen.queryByText('Jane Seller')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/review')).toHaveLength(1);
    expect(screen.getByText('Sam Seller')).toBeInTheDocument();
  });

  it('does not reload the list for other failures such as NOT_OWNER', async () => {
    stubApi({ 'GET /api/review': twoItems });
    renderWithRouter(<ReviewPage />);
    await screen.findByText('Jane Seller');
    const calls = stubApi({ 'GET /api/review': twoItems, [`POST /api/review/${ENROLLMENT_ID}`]: respond(403, { error: 'Not the owner', code: 'NOT_OWNER' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss flag for Jane Seller' }));
    await screen.findByRole('alert');
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/review')).toHaveLength(0);
  });

  it('says when there is nothing to review', async () => {
    stubApi({ 'GET /api/review': { items: [] } });
    renderWithRouter(<ReviewPage />);
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
  });
});
