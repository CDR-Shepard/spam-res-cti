/** @vitest-environment jsdom */
/**
 * The hold-music picker's PATCH shapes, toasts, and inline YouTube-link
 * errors — the pure rendering/selection cases live in SettingsPanel.test.tsx
 * (SSR); this file needs a mounted panel to click the select and the Save
 * button and to await the async PATCH round trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HoldMusicSetting } from '@cti/contracts';
import { SettingsPanel } from './SettingsPanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: vi.fn(async () => ({ ok: true })) }));

const mockedApi = vi.mocked(api);

const noop = () => {};

describe('SettingsPanel picker — PATCH shapes, toasts, YouTube link errors', () => {
  beforeEach(() => { mockedApi.mockReset(); mockedApi.mockResolvedValue({ ok: true }); });
  afterEach(() => { cleanup(); });

  it('picking Rock PATCHes the choice, refetches, and toasts the label', async () => {
    const onSaved = vi.fn(async () => {});
    const onToast = vi.fn();
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={onSaved}
        onToast={onToast}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'rock' } });
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/auth/me', {
      method: 'PATCH',
      body: { holdMusic: { choice: 'rock' } },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      text: 'Hold music: Rock — from your next run.',
      type: 'success',
    }));
  });

  it('picking Off toasts the silence copy', async () => {
    const onToast = vi.fn();
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={noop}
        onToast={onToast}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'off' } });
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      text: 'Hold music off — silence between calls from your next run.',
      type: 'success',
    }));
  });

  it('picking YouTube with nothing saved shows the link box without PATCHing', async () => {
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={noop}
        onToast={noop}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'youtube' } });
    expect(await screen.findByPlaceholderText('Paste a YouTube playlist or video link')).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalledWith('/auth/me', expect.objectContaining({ method: 'PATCH' }));
  });

  it('a bad link shows the sentence inline and does not PATCH', async () => {
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={noop}
        onToast={noop}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'youtube' } });
    const input = await screen.findByPlaceholderText('Paste a YouTube playlist or video link');
    fireEvent.change(input, { target: { value: 'https://vimeo.com/1' } });
    fireEvent.click(within(input.closest('.set-youtube') as HTMLElement).getByText('Save'));
    expect(await screen.findByText("That doesn't look like a YouTube link.")).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalledWith('/auth/me', expect.objectContaining({ method: 'PATCH' }));
  });

  it('a valid link PATCHes choice + youtubeLink', async () => {
    const onSaved = vi.fn(async () => {});
    const onToast = vi.fn();
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={onSaved}
        onToast={onToast}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'youtube' } });
    const input = await screen.findByPlaceholderText('Paste a YouTube playlist or video link');
    const link = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
    fireEvent.change(input, { target: { value: link } });
    fireEvent.click(within(input.closest('.set-youtube') as HTMLElement).getByText('Save'));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/auth/me', {
      method: 'PATCH',
      body: { holdMusic: { choice: 'youtube', youtubeLink: link } },
    }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      text: 'Hold music: YouTube — from your next run.',
      type: 'success',
    }));
  });

  it('a 400 from the API shows its own error sentence inline', async () => {
    // Only the hold-music PATCH should 400 — MobilePairingCard's own GET on
    // mount must keep resolving, or this pins the wrong call.
    mockedApi.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/auth/me' && init?.method === 'PATCH') {
        throw { status: 400, data: { error: 'That playlist is private.' } };
      }
      return { ok: true };
    });
    render(
      <SettingsPanel
        forwardE164={null}
        holdMusic={{ choice: 'classical', youtube: null }}
        onSaved={noop}
        onToast={noop}
      />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'youtube' } });
    const input = await screen.findByPlaceholderText('Paste a YouTube playlist or video link');
    fireEvent.change(input, { target: { value: 'https://youtu.be/dQw4w9WgXcQ' } });
    fireEvent.click(within(input.closest('.set-youtube') as HTMLElement).getByText('Save'));
    expect(await screen.findByText('That playlist is private.')).toBeTruthy();
  });

  it('picking YouTube when a playlist is already saved restores it immediately', async () => {
    const onSaved = vi.fn(async () => {});
    const onToast = vi.fn();
    const saved: HoldMusicSetting = { choice: 'rock', youtube: { listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', videoId: null } };
    render(
      <SettingsPanel forwardE164={null} holdMusic={saved} onSaved={onSaved} onToast={onToast} />,
    );
    fireEvent.change(screen.getByLabelText('Hold music'), { target: { value: 'youtube' } });
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/auth/me', {
      method: 'PATCH',
      body: { holdMusic: { choice: 'youtube' } },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
