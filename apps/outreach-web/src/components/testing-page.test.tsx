import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '../test/render';
import { stubApi } from '../test/stub-api';
import { inboundResponse, phonesResponse, testPhone } from '../test/testing-fixtures';
import { TestingPage } from './testing-page';

afterEach(() => vi.unstubAllGlobals());

describe('TestingPage', () => {
  it('tells a non-admin it is not for them, and asks for nothing', async () => {
    const calls = stubApi({});
    renderWithRouter(<TestingPage />);
    expect(await screen.findByText('Only admins can use the Testing page.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Test phones' })).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('shows an admin the title, the test phones and the inbound calls', async () => {
    stubApi({ 'GET /api/testing/phones': phonesResponse(testPhone()), 'GET /api/testing/inbound-calls': inboundResponse() });
    renderWithRouter(<TestingPage />, { isAdmin: true });
    expect(await screen.findByRole('heading', { level: 1, name: 'Testing' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Test phones' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Inbound calls' })).toBeInTheDocument();
    expect(await screen.findByText('Grant cell')).toBeInTheDocument();
    expect(await screen.findByText('No inbound test calls yet.')).toBeInTheDocument();
  });
});
