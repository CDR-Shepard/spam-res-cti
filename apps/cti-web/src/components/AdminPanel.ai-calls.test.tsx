/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminPanel } from './AdminPanel';
import * as apiModule from '../api';

vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), api: vi.fn() }));

const AI = { id: 'n-ai', e164: '+16197244374', label: 'AI calls (ai_pool)', active: true, health: 'unknown', assignedUserId: null, kind: 'ai_pool', createdAt: '' };
const AGENT = { id: 'n-ag', e164: '+16195550100', label: null, active: true, health: 'healthy', assignedUserId: 'rep-1', kind: 'agent', createdAt: '' };

function mockApi() {
  const calls: Array<[string, unknown]> = [];
  vi.mocked(apiModule.api).mockImplementation((async (path: string, opts?: { method?: string; body?: unknown }) => {
    calls.push([`${opts?.method ?? 'GET'} ${path}`, opts?.body]);
    if (path === '/admin/outbound-numbers' && !opts?.method) return { numbers: [AI, AGENT] };
    if (path === '/admin/reps') return { reps: [{ id: 'rep-1', email: 'ada@x.com', displayName: 'Ada', isAdmin: false }] };
    if (path === '/admin/dnc-mode') return { mode: 'registry' };
    if (path === '/admin/followup-rollovers') return { succeeded: 0, failed: [] };
    if (path.startsWith('/admin/outbound-numbers/')) return { number: { ...AGENT, ...(opts?.body as object) } };
    if (path === '/admin/outbound-numbers') return { number: { ...AI, id: 'n-new', ...(opts?.body as object) } };
    return {};
  }) as never);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AdminPanel — AI calls numbers', () => {
  it('lists AI numbers under their own "AI calls" group, not the reserve pool', async () => {
    mockApi();
    render(<AdminPanel />);
    const aiNumber = await screen.findByText('+1 (619) 724-4374');
    const group = aiNumber.closest('.admin-group') as HTMLElement;
    expect(within(group).getByText('AI calls', { selector: '.g-title' })).toBeTruthy();
    expect((within(group).getByRole('combobox') as HTMLSelectElement).value).toBe('__ai_calls__');
  });

  it('moving a rep number to AI calls PATCHes kind ai_pool, unassigned', async () => {
    const calls = mockApi();
    render(<AdminPanel />);
    const agentNumber = await screen.findByText('+1 (619) 555-0100');
    const select = within(agentNumber.closest('.admin-num') as HTMLElement).getByRole('combobox');
    fireEvent.change(select, { target: { value: '__ai_calls__' } });
    await waitFor(() =>
      expect(calls).toContainEqual(['PATCH /admin/outbound-numbers/n-ag', { kind: 'ai_pool', assignedUserId: null }]),
    );
  });

  it('Add → "AI calls" posts the number as ai_pool', async () => {
    const calls = mockApi();
    render(<AdminPanel />);
    await screen.findByText('+1 (619) 724-4374');
    fireEvent.click(screen.getByRole('button', { name: /Add$/ }));
    fireEvent.change(screen.getByPlaceholderText('+16195551234'), { target: { value: '+16197244375' } });
    const addSelect = document.querySelector('.admin-add select') as HTMLSelectElement;
    fireEvent.change(addSelect, { target: { value: '__ai_calls__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add number' }));
    await waitFor(() =>
      expect(calls).toContainEqual([
        'POST /admin/outbound-numbers',
        { e164: '+16197244375', label: undefined, kind: 'ai_pool', assignedUserId: null },
      ]),
    );
  });
});
