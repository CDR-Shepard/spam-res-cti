/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AiCallPanel, FAST_POLL_MS, SLOW_POLL_MS } from './AiCallPanel';
import * as aiApi from '../ai-calls-api';
import type { AiCallRow } from '../ai-calls-api';
import { ApiError } from '../api';

vi.mock('../ai-calls-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-calls-api')>()),
  listAiCalls: vi.fn(),
  getAiCall: vi.fn(),
  startAiCall: vi.fn(),
}));

const NOW = new Date('2026-10-05T16:00:00Z');

function row(over: Partial<AiCallRow> = {}): AiCallRow {
  return {
    id: 'ai-1',
    sfObject: 'Lead',
    sfRecordId: '00Q5e00000AbCdE',
    toE164: '+16195551234',
    isTest: false,
    status: 'completed',
    outcome: 'qualified_callback',
    blockReason: null,
    summary: 'Wants to sell by spring.\n\nOutcome: Callback requested',
    transcript: null,
    durationSeconds: 125,
    startedAt: '2026-10-05T15:00:00Z',
    endedAt: '2026-10-05T15:02:05Z',
    createdAt: '2026-10-05T14:59:58Z',
    updatedAt: '2026-10-05T15:02:10Z',
    ...over,
  };
}

const LIVE = row({ id: 'ai-live', status: 'in_progress', outcome: null, summary: null, durationSeconds: null, endedAt: null, updatedAt: '2026-10-05T15:59:50Z' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
  vi.mocked(aiApi.listAiCalls).mockResolvedValue([row()]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('AiCallPanel — the list', () => {
  it('shows status, outcome, number, duration and summary', async () => {
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    expect(await screen.findByText('Completed')).toBeTruthy();
    expect(screen.getByText('Callback requested')).toBeTruthy();
    expect(screen.getByText('+1 (619) 555-1234')).toBeTruthy();
    expect(screen.getByText('2:05')).toBeTruthy();
    expect(screen.getByText(/Wants to sell by spring/)).toBeTruthy();
    expect(aiApi.listAiCalls).toHaveBeenCalledWith(20);
  });

  it('a blocked call says why in plain words', async () => {
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([row({ status: 'blocked', outcome: 'blocked', blockReason: 'calling_hours', summary: null })]);
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    expect(await screen.findByText(/outside calling hours/)).toBeTruthy();
  });

  it('no calls yet', async () => {
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([]);
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    expect(await screen.findByText('No AI calls yet.')).toBeTruthy();
  });

  it('tapping a call fetches GET /ai-calls/:id and shows its transcript', async () => {
    vi.mocked(aiApi.getAiCall).mockResolvedValue(row({
      transcript: [
        { role: 'agent', text: "Hi, I'm an AI assistant calling for GG Homes.", at: '2026-10-05T15:00:01Z' },
        { role: 'caller', text: 'Oh, hi.', at: '2026-10-05T15:00:04Z' },
      ],
    }));
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    const head = await screen.findByRole('button', { expanded: false });
    fireEvent.click(head);
    expect(await screen.findByText(/calling for GG Homes/)).toBeTruthy();
    expect(screen.getByText('Oh, hi.')).toBeTruthy();
    expect(aiApi.getAiCall).toHaveBeenCalledWith('ai-1');
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });

  it('polls every 4 s while a call is live, then slows to 30 s once all have ended', async () => {
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([LIVE]);
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    await screen.findByText('In progress');
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(FAST_POLL_MS); });
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(2);

    // The call ended long enough ago to be past the after-end grace.
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([row({ id: 'ai-live', endedAt: '2026-10-05T15:00:00Z' })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(FAST_POLL_MS); });
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(3);
    await screen.findByText('Completed');

    await act(async () => { await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3); });
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(3); // no more fast polls
    await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_POLL_MS); });
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(4);
  });

  it('does not poll while the page is hidden', async () => {
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([LIVE]);
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    await screen.findByText('In progress');
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 2); });
    expect(aiApi.listAiCalls).toHaveBeenCalledTimes(1);
    vis.mockRestore();
  });

  it('an open live call re-fetches its transcript when the list shows it changed', async () => {
    vi.mocked(aiApi.listAiCalls).mockResolvedValue([LIVE]);
    vi.mocked(aiApi.getAiCall).mockResolvedValue({ ...LIVE, transcript: [{ role: 'agent', text: 'Hello there.' }] });
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    fireEvent.click(await screen.findByRole('button', { expanded: false }));
    await screen.findByText('Hello there.');
    expect(aiApi.getAiCall).toHaveBeenCalledTimes(1);

    vi.mocked(aiApi.listAiCalls).mockResolvedValue([{ ...LIVE, updatedAt: '2026-10-05T15:59:59Z' }]);
    vi.mocked(aiApi.getAiCall).mockResolvedValue({ ...LIVE, updatedAt: '2026-10-05T15:59:59Z', transcript: [{ role: 'agent', text: 'Hello there.' }, { role: 'caller', text: 'Who is this?' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(FAST_POLL_MS); });
    expect(await screen.findByText('Who is this?')).toBeTruthy();
  });
});

describe('AiCallPanel — Test AI call (admins)', () => {
  it('reps do not see it', async () => {
    render(<AiCallPanel isAdmin={false} testNumbers={[]} available />);
    await screen.findByText('Completed');
    expect(screen.queryByText('Test AI call')).toBeNull();
  });

  it('prefills the first test number, switches with the quick buttons, and posts testTo', async () => {
    vi.mocked(aiApi.startAiCall).mockResolvedValue({ aiCallId: 'ai-9', status: 'ringing' });
    render(<AiCallPanel isAdmin testNumbers={['+16195550100', '+16195550111']} available />);
    const input = screen.getByLabelText('Test number') as HTMLInputElement;
    expect(input.value).toBe('+16195550100');
    fireEvent.click(screen.getByRole('button', { name: '+1 (619) 555-0111' }));
    expect(input.value).toBe('+16195550111');
    fireEvent.click(screen.getByRole('button', { name: 'Start test call' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(aiApi.startAiCall).toHaveBeenCalledWith({ testTo: '+16195550111' });
    await waitFor(() => expect(aiApi.listAiCalls).toHaveBeenCalledTimes(2)); // the list reloads at once
  });

  it('a refused test call says why', async () => {
    vi.mocked(aiApi.startAiCall).mockRejectedValue(new ApiError(409, { error: 'not_admin_for_test', aiCallId: 'x' }));
    render(<AiCallPanel isAdmin testNumbers={['+16195550100']} available />);
    fireEvent.change(screen.getByLabelText('Test number'), { target: { value: '+16195559999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start test call' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/only to the configured test numbers/);
  });

  it('says when AI calling is off', async () => {
    render(<AiCallPanel isAdmin testNumbers={[]} available={false} />);
    expect(screen.getByText(/AI calling is turned off/)).toBeTruthy();
    expect(screen.getByText(/No test numbers are set/)).toBeTruthy();
    await screen.findByText('Completed');
  });
});
