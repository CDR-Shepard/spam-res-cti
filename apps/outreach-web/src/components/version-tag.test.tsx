import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { VersionTag } from './version-tag';

const ROUTE = 'GET /api/version';
const REFRESH = 'New version — refresh';
const STARTED_AT = '2026-10-13T16:41:00.000Z';
const version = (appCommit = '8a398bc', calls: { commit: string } | null = { commit: '8a398bc' }) => ({ app: { commit: appCommit, startedAt: STARTED_AT }, calls });
const DEPLOYED = /^deployed Oct 13, \d{1,2}:\d{2} [AP]M$/;

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')!;
/** jsdom's `location.reload` cannot be spied on; swap the whole (configurable) `location`, as routes/-routes.test.tsx does. */
function stubReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, reload } });
  return reload;
}

beforeEach(() => vi.stubEnv('VITE_APP_COMMIT', '8a398bc1f0e2d4c6b8a7e9f01234567890abcdef'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', originalLocation);
});

describe('VersionTag', () => {
  it('shows the App and Calls commits and when the live app was deployed', async () => {
    stubApi({ [ROUTE]: version('8a398bc', { commit: '1234567' }) });
    renderWithProviders(<VersionTag />);
    expect(await screen.findByText(/^Calls 1234567$/)).toBeInTheDocument();
    expect(screen.getByText(/^App 8a398bc$/)).toBeInTheDocument();
    expect(screen.getByText(DEPLOYED)).toBeInTheDocument();
  });

  it('says "Calls unknown" when the AI voice server could not be reached', async () => {
    stubApi({ [ROUTE]: version('8a398bc', null) });
    renderWithProviders(<VersionTag />);
    expect(await screen.findByText(/^Calls unknown$/)).toBeInTheDocument();
    expect(screen.getByText(/^App 8a398bc$/)).toBeInTheDocument();
  });

  it('shows just "App <this tab\'s commit>" while it loads', async () => {
    stubApi({ [ROUTE]: version() });
    renderWithProviders(<VersionTag />);
    expect(screen.getByText(/^App 8a398bc$/)).toBeInTheDocument();
    expect(screen.queryByText(/Calls/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deployed/)).not.toBeInTheDocument();
    await screen.findByText(/^Calls 8a398bc$/);
  });

  it.each([
    ['a 500', respond(500, { error: 'boom', code: 'INTERNAL' })],
    ['a 404', undefined],
    ['a body that is not a version', { nope: true }],
  ])('after %s it stays quiet: just "App <commit>", no error, no refresh button', async (_label, answer) => {
    const calls = stubApi(answer === undefined ? {} : { [ROUTE]: answer });
    renderWithProviders(<VersionTag />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText(/^App 8a398bc$/)).toBeInTheDocument();
    expect(screen.queryByText(/Calls|deployed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  describe('the refresh button', () => {
    it('is not there while this tab is on the live commit', async () => {
      stubApi({ [ROUTE]: version('8a398bc') });
      renderWithProviders(<VersionTag />);
      await screen.findByText(/^Calls 8a398bc$/);
      expect(screen.queryByRole('button', { name: REFRESH })).not.toBeInTheDocument();
    });

    it('appears when the live app is on a different commit, and clicking it reloads the tab', async () => {
      const reload = stubReload();
      stubApi({ [ROUTE]: version('1234567', { commit: '1234567' }) });
      renderWithProviders(<VersionTag />);
      const button = await screen.findByRole('button', { name: REFRESH });
      expect(reload).not.toHaveBeenCalled();
      await userEvent.click(button);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('never appears for a dev build (no commit baked in)', async () => {
      vi.stubEnv('VITE_APP_COMMIT', '');
      stubApi({ [ROUTE]: version('1234567') });
      renderWithProviders(<VersionTag />);
      expect(await screen.findByText(/^App 1234567$/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: REFRESH })).not.toBeInTheDocument();
    });

    it('never appears while the live app does not know its own commit', async () => {
      stubApi({ [ROUTE]: version('dev') });
      renderWithProviders(<VersionTag />);
      expect(await screen.findByText(/^App dev$/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: REFRESH })).not.toBeInTheDocument();
    });

    it('does not depend on the Calls commit: Calls on another commit, or unknown, does not ask for a refresh', async () => {
      stubApi({ [ROUTE]: version('8a398bc', { commit: '1234567' }) });
      renderWithProviders(<VersionTag />);
      await screen.findByText(/^Calls 1234567$/);
      expect(screen.queryByRole('button', { name: REFRESH })).not.toBeInTheDocument();
    });
  });

  describe('keeping itself current', () => {
    it('asks again every 60 seconds, and the button shows up once a push has gone live', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let answer = version('8a398bc');
      const calls = stubApi({});
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        calls.push({ url: String(input), method: 'GET', body: undefined });
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }));
      renderWithProviders(<VersionTag />);
      await screen.findByText(/^Calls 8a398bc$/);
      const before = calls.length;
      expect(screen.queryByRole('button', { name: REFRESH })).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(calls.length).toBe(before);

      answer = version('1234567', { commit: '1234567' });
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(await screen.findByRole('button', { name: REFRESH })).toBeInTheDocument();
      expect(calls.length).toBe(before + 1);
      expect(screen.getByText(/^App 1234567$/)).toBeInTheDocument();
    });

    it('asks again when the window gets focus back', async () => {
      const calls = stubApi({ [ROUTE]: version('8a398bc') });
      renderWithProviders(<VersionTag />);
      await screen.findByText(/^Calls 8a398bc$/);
      expect(calls).toHaveLength(1);
      act(() => { focusManager.setFocused(false); });
      act(() => { focusManager.setFocused(true); });
      await waitFor(() => expect(calls).toHaveLength(2));
      act(() => { focusManager.setFocused(undefined); });
    });
  });
});
