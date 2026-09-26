/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallbackBanner } from './CallbackBanner';
import * as chime from '../callback-chime';

beforeEach(() => { vi.spyOn(chime, 'playCallbackChime').mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CallbackBanner', () => {
  it('names the caller and the record type', () => {
    render(<CallbackBanner callerLabel="Jane Doe" recordType="Lead" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(screen.getByText('Callback: Jane Doe · Lead')).toBeTruthy();
  });

  it('with no record type, just the caller', () => {
    render(<CallbackBanner callerLabel="+1 (619) 555-1234" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(screen.getByText('Callback: +1 (619) 555-1234')).toBeTruthy();
  });

  it('Pause & answer and Ignore call their handlers', () => {
    const onAnswer = vi.fn();
    const onIgnore = vi.fn();
    render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={onAnswer} onIgnore={onIgnore} />);
    fireEvent.click(screen.getByText('Pause & answer'));
    fireEvent.click(screen.getByText('Ignore'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });

  it('while the pause is in flight both buttons are disabled, and Answer says so', () => {
    render(<CallbackBanner callerLabel="Jane Doe" busy onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect((screen.getByText('Pausing…') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Ignore') as HTMLButtonElement).disabled).toBe(true);
  });

  it('chimes once when it appears — not again on a re-render', () => {
    const { rerender } = render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    rerender(<CallbackBanner callerLabel="Jane Doe" busy onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    expect(chime.playCallbackChime).toHaveBeenCalledTimes(1);
  });

  it('a chime the browser refuses is logged, not thrown — the banner is the signal', async () => {
    vi.mocked(chime.playCallbackChime).mockRejectedValue(new Error('NotAllowedError'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<CallbackBanner callerLabel="Jane Doe" busy={false} onAnswer={vi.fn()} onIgnore={vi.fn()} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[callback] chime did not play', expect.any(Error)));
    expect(screen.getByText('Callback: Jane Doe')).toBeTruthy();
  });
});
