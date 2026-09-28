/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPanel } from './SettingsPanel';

vi.mock('../api', () => ({ api: vi.fn(async () => ({ devices: [] })) }));

const base = { forwardE164: null, holdMusic: { choice: 'off' as const, youtube: null }, onSaved: () => {}, onToast: () => {} };
afterEach(() => { cleanup(); });

describe('SettingsPanel — Run sound check and Reset my audio', () => {
  it('both buttons hand off to App', () => {
    const run = vi.fn();
    const reset = vi.fn();
    render(<SettingsPanel {...base} onRunSoundCheck={run} onResetAudio={reset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run sound check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset my audio' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('without the handlers the row is not shown', () => {
    render(<SettingsPanel {...base} />);
    expect(screen.queryByRole('button', { name: 'Run sound check' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset my audio' })).toBeNull();
  });
});
