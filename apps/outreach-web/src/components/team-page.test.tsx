import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { TeamPage } from './team-page';

afterEach(() => vi.unstubAllGlobals());

interface ErrorRoute { status: number; body: unknown }
function isErrorRoute(v: unknown): v is ErrorRoute {
  return typeof v === 'object' && v !== null && 'status' in v && 'body' in v;
}

function stubApi(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url}`;
    const route = routes[key];
    if (route === undefined) return new Response(JSON.stringify({ error: 'nf', code: 'NOT_FOUND' }), { status: 404 });
    if (isErrorRoute(route)) return new Response(JSON.stringify(route.body), { status: route.status, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(route), { status: method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } });
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
  it('renders a friendly message when a PATCH is rejected as a self-demotion', async () => {
    // renderWithProviders' fake session is userId 'U1' — target a different
    // member (U2) so the "Remove admin" button isn't disabled for being self.
    stubApi({
      'GET /api/team': { members: [{ id: 'U2', email: 'rep@gg.co', displayName: null, isAdmin: true, powerDialerEnabled: false, signedIn: true }] },
      'GET /api/team/invites': { invites: [] },
      'PATCH /api/team/U2': { status: 403, body: { error: 'Cannot demote', code: 'CANNOT_DEMOTE_SELF' } },
    });
    renderWithProviders(<TeamPage />, { isAdmin: true });
    await screen.findByText('rep@gg.co');
    await userEvent.click(screen.getByRole('button', { name: /remove admin/i }));
    expect(await screen.findByText("You can't remove your own admin access.")).toBeInTheDocument();
  });
});
