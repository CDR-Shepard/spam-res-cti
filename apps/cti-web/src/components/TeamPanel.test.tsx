/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamPanel } from './TeamPanel';
import * as teamApi from '../team-api';
import { formatClock } from '../reset-status';

vi.mock('../team-api');

const users: teamApi.TeamUser[] = [
  { id: 'u1', email: 'rep@x.com', displayName: 'Ada Rep', isAdmin: false, powerDialerEnabled: false, ctiResetRequestedAt: null, ctiResetCompletedAt: null },
  { id: 'u2', email: 'boss@x.com', displayName: 'Bea Boss', isAdmin: true, powerDialerEnabled: true, ctiResetRequestedAt: null, ctiResetCompletedAt: null },
];
const REQUESTED = '2026-09-28T21:41:00.000Z';
const DONE = '2026-09-28T21:43:00.000Z';

beforeEach(() => {
  vi.mocked(teamApi.listTeam).mockResolvedValue({ users });
  vi.mocked(teamApi.setPowerDialer).mockImplementation(async (id, v) => ({ user: { id, powerDialerEnabled: v } }));
  vi.mocked(teamApi.resetCti).mockImplementation(async (id) => ({ user: { id, ctiResetRequestedAt: REQUESTED, ctiResetCompletedAt: null } }));
  vi.mocked(teamApi.resetCtiEveryone).mockResolvedValue({ count: 1 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

describe('TeamPanel — Reset CTI', () => {
  it("shows each person's status: pending since the request, done at the completion", async () => {
    vi.mocked(teamApi.listTeam).mockResolvedValue({
      users: [
        { ...users[0]!, ctiResetRequestedAt: REQUESTED },
        { ...users[1]!, ctiResetRequestedAt: REQUESTED, ctiResetCompletedAt: DONE },
      ],
    });
    render(<TeamPanel />);
    expect(await screen.findByText(`Reset pending since ${formatClock(REQUESTED)}`)).toBeTruthy();
    expect(screen.getByText(`Reset done ${formatClock(DONE)}`)).toBeTruthy();
  });

  it('Reset CTI on a row resets that person and shows it pending', async () => {
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }));
    expect(teamApi.resetCti).toHaveBeenCalledWith('u1');
    expect(await screen.findByText(`Reset pending since ${formatClock(REQUESTED)}`)).toBeTruthy();
  });

  it('a failed reset says so and shows no status', async () => {
    vi.mocked(teamApi.resetCti).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }));
    expect(await screen.findByText('Could not reset Ada Rep.')).toBeTruthy();
    expect(screen.queryByText(/Reset pending since/)).toBeNull();
  });

  it('Reset everyone asks first; Cancel sends nothing', async () => {
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset everyone' }));
    expect(screen.getByText('Reset the softphone of everyone in your org except you?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(teamApi.resetCtiEveryone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reset everyone' })).toBeTruthy();
  });

  it('confirming resets everyone, says how many, and reloads the list to show their status', async () => {
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset everyone' }));
    vi.mocked(teamApi.listTeam).mockResolvedValue({ users: [{ ...users[0]!, ctiResetRequestedAt: REQUESTED }, users[1]!] });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset everyone' }));
    expect(await screen.findByText('Reset sent to 1 person.')).toBeTruthy();
    expect(teamApi.resetCtiEveryone).toHaveBeenCalledTimes(1);
    expect(teamApi.listTeam).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(`Reset pending since ${formatClock(REQUESTED)}`)).toBeTruthy();
  });

  it('a failed "reset everyone" says so', async () => {
    vi.mocked(teamApi.resetCtiEveryone).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset everyone' }));
    expect(await screen.findByText('Could not reset everyone.')).toBeTruthy();
  });
});
