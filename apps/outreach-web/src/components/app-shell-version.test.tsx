import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test/render';
import { stubApi } from '../test/stub-api';
import { AppShell } from './app-shell';
import { VersionTag } from './version-tag';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const version = { app: { commit: '8a398bc', startedAt: '2026-10-13T16:41:00.000Z' }, calls: { commit: '8a398bc' } };

describe('AppShell sidebarFooter', () => {
  it('shows what it is given at the bottom of the sidebar, under Sign out', async () => {
    vi.stubEnv('VITE_APP_COMMIT', '8a398bc');
    stubApi({ 'GET /api/version': version });
    renderWithRouter(<AppShell sidebarFooter={<VersionTag />}><p>page</p></AppShell>);
    const signOut = await screen.findByRole('button', { name: 'Sign out' });
    await screen.findByText(/^Calls 8a398bc$/);
    const tag = screen.getByText(/^App 8a398bc$/);
    // Same block as Sign out, and after it in the document.
    expect(signOut.parentElement).toContainElement(tag);
    expect(signOut.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(signOut.parentElement!).getByText(/^Calls 8a398bc$/)).toBeInTheDocument();
  });

  it('with no footer, the shell shows no version and asks for none', async () => {
    const calls = stubApi({});
    renderWithRouter(<AppShell><p>page</p></AppShell>);
    await screen.findByRole('button', { name: 'Sign out' });
    expect(screen.queryByText(/^App /)).not.toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('the mobile drawer carries it too', async () => {
    vi.stubEnv('VITE_APP_COMMIT', '8a398bc');
    stubApi({ 'GET /api/version': version });
    renderWithRouter(<AppShell sidebarFooter={<VersionTag />}><p>page</p></AppShell>);
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/^App 8a398bc$/)).toBeInTheDocument();
  });
});
