/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamPanel } from './TeamPanel';
import * as teamApi from '../team-api';

vi.mock('../team-api');

const users = [
  { id: 'u1', email: 'rep@x.com', displayName: 'Ada Rep', isAdmin: false, powerDialerEnabled: false },
  { id: 'u2', email: 'boss@x.com', displayName: 'Bea Boss', isAdmin: true, powerDialerEnabled: true },
];

beforeEach(() => {
  vi.mocked(teamApi.listTeam).mockResolvedValue({ users });
  vi.mocked(teamApi.setPowerDialer).mockImplementation(async (id, v) => ({ user: { id, powerDialerEnabled: v } }));
});

describe('TeamPanel', () => {
  it('lists the org users with their flags', async () => {
    render(<TeamPanel />);
    expect(await screen.findByText('Ada Rep')).toBeTruthy();
    expect(screen.getByText('Bea Boss')).toBeTruthy();
  });

  it('toggling a user PATCHes and flips optimistically', async () => {
    render(<TeamPanel />);
    const toggle = (await screen.findAllByRole('switch'))[0]!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(teamApi.setPowerDialer).toHaveBeenCalledWith('u1', true);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });

  it('a failed PATCH reverts the toggle', async () => {
    vi.mocked(teamApi.setPowerDialer).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    const toggle = (await screen.findAllByRole('switch'))[0]!;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });
});
