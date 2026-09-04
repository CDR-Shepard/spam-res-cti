import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { TeamPage } from './team-page';

afterEach(() => vi.unstubAllGlobals());

function stubApi(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url}`;
    const body = routes[key];
    if (body === undefined) return new Response(JSON.stringify({ error: 'nf', code: 'NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

describe('TeamPage', () => {
  it('renders members with admin badges and pending invites', async () => {
    stubApi({
      'GET /api/team': { members: [{ id: 'U1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, signedIn: true }, { id: 'U2', email: 'rep@gg.co', displayName: null, isAdmin: false, powerDialerEnabled: true, signedIn: false }] },
      'GET /api/team/invites': { invites: [{ id: 'i1', email: 'new@gg.co', role: 'member', state: 'pending', expiresAt: '2026-09-11T00:00:00Z' }] },
    });
    renderWithProviders(<TeamPage />, { isAdmin: true });
    expect(await screen.findByText('admin@gg.co')).toBeInTheDocument();
    expect(screen.getByText('rep@gg.co')).toBeInTheDocument();
    expect(screen.getAllByText('Admin')).not.toHaveLength(0);
    expect(await screen.findByText('new@gg.co')).toBeInTheDocument();
  });
  it('submits an invite and refreshes the list', async () => {
    const calls = stubApi({
      'GET /api/team': { members: [] },
      'GET /api/team/invites': { invites: [] },
      'POST /api/team/invites': { id: 'i2', email: 'x@gg.co', role: 'member', state: 'pending', expiresAt: '2026-09-11T00:00:00Z' },
    });
    renderWithProviders(<TeamPage />, { isAdmin: true });
    await screen.findByText(/no pending invites/i);
    await userEvent.type(screen.getByLabelText(/email/i), 'x@gg.co');
    await userEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/team/invites')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'x@gg.co', role: 'member' });
  });
});
