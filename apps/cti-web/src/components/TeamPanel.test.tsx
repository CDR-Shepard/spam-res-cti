/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TeamPanel } from './TeamPanel';
import * as teamApi from '../team-api';
import { formatStamp } from '../reset-status';

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
    expect(await screen.findByText(`Reset requested ${formatStamp(REQUESTED)}`)).toBeTruthy();
    expect(screen.getByText(`Reset done ${formatStamp(DONE)}`)).toBeTruthy();
  });

  it('Reset CTI on a row resets that person and shows it pending', async () => {
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }));
    expect(teamApi.resetCti).toHaveBeenCalledWith('u1');
    expect(await screen.findByText(`Reset requested ${formatStamp(REQUESTED)}`)).toBeTruthy();
  });

  it('a failed reset says so and shows no status', async () => {
    vi.mocked(teamApi.resetCti).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }));
    expect(await screen.findByText('Could not reset Ada Rep.')).toBeTruthy();
    expect(screen.queryByText(/Reset requested/)).toBeNull();
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
    expect(await screen.findByText(`Reset requested ${formatStamp(REQUESTED)}`)).toBeTruthy();
  });

  it('a failed "reset everyone" says so', async () => {
    vi.mocked(teamApi.resetCtiEveryone).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset everyone' }));
    expect(await screen.findByText('Could not reset everyone.')).toBeTruthy();
  });
});

// Task 3 review M-a, M-b, M-c.
describe('TeamPanel — Reset CTI buttons, status, refresh and errors', () => {
  it("another row's click never re-enables a row whose reset is still in flight", async () => {
    const answers = new Map<string, () => void>();
    vi.mocked(teamApi.resetCti).mockImplementation((id) => new Promise((resolve) => {
      answers.set(id, () => resolve({ user: { id, ctiResetRequestedAt: REQUESTED, ctiResetCompletedAt: null } }));
    }));
    render(<TeamPanel />);
    const ada = await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }) as HTMLButtonElement;
    const bea = screen.getByRole('button', { name: 'Reset CTI for Bea Boss' }) as HTMLButtonElement;
    fireEvent.click(ada);
    fireEvent.click(bea);
    expect(ada.disabled).toBe(true);
    expect(bea.disabled).toBe(true);
    answers.get('u2')!();
    await waitFor(() => expect(bea.disabled).toBe(false));
    expect(ada.disabled).toBe(true); // still in flight
    answers.get('u1')!();
    await waitFor(() => expect(ada.disabled).toBe(false));
  });

  it('while "Reset everyone" is in flight, no row can be reset on its own', async () => {
    let finish: () => void = () => {};
    vi.mocked(teamApi.resetCtiEveryone).mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ count: 1 }); }));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset everyone' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset everyone' }));
    for (const name of ['Reset CTI for Ada Rep', 'Reset CTI for Bea Boss']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    finish();
    await screen.findByText('Reset sent to 1 person.');
    expect((screen.getByRole('button', { name: 'Reset CTI for Ada Rep' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a pending row says when it will happen; a done row does not', async () => {
    vi.mocked(teamApi.listTeam).mockResolvedValue({
      users: [
        { ...users[0]!, ctiResetRequestedAt: REQUESTED },
        { ...users[1]!, ctiResetRequestedAt: REQUESTED, ctiResetCompletedAt: DONE },
      ],
    });
    render(<TeamPanel />);
    await screen.findByText(`Reset requested ${formatStamp(REQUESTED)}`);
    expect(screen.getAllByText('Happens the next time their softphone is open and idle.')).toHaveLength(1);
    expect(screen.queryByText(/Waiting for them/)).toBeNull();
  });

  it('Refresh re-fetches the team and shows the latest status', async () => {
    render(<TeamPanel />);
    await screen.findByText('Ada Rep');
    vi.mocked(teamApi.listTeam).mockResolvedValue({ users: [{ ...users[0]!, ctiResetRequestedAt: REQUESTED, ctiResetCompletedAt: DONE }, users[1]!] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(`Reset done ${formatStamp(DONE)}`)).toBeTruthy();
    expect(teamApi.listTeam).toHaveBeenCalledTimes(2);
  });

  it('a failed Refresh says so', async () => {
    render(<TeamPanel />);
    await screen.findByText('Ada Rep');
    vi.mocked(teamApi.listTeam).mockRejectedValue(new Error('nope'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not refresh the team.');
  });

  it('the error line is announced (role="alert")', async () => {
    vi.mocked(teamApi.resetCti).mockRejectedValue(new Error('nope'));
    render(<TeamPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset CTI for Ada Rep' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reset Ada Rep.');
  });
});
