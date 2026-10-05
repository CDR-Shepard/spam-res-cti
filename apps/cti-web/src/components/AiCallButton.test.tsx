/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AiCallButton } from './AiCallButton';
import * as aiApi from '../ai-calls-api';
import { ApiError } from '../api';

vi.mock('../ai-calls-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-calls-api')>()),
  startAiCall: vi.fn(),
}));

const LEAD = { objectType: 'Lead' as const, recordId: '00Q5e00000AbCdE' };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiCallButton', () => {
  it('shows only when AI calling is available and a supported record is in context', () => {
    const { rerender } = render(<AiCallButton target={LEAD} available={false} onStarted={() => {}} />);
    expect(screen.queryByRole('button', { name: 'AI call' })).toBeNull();
    rerender(<AiCallButton target={null} available onStarted={() => {}} />);
    expect(screen.queryByRole('button', { name: 'AI call' })).toBeNull();
    rerender(<AiCallButton target={LEAD} available recordName="Jane Doe" onStarted={() => {}} />);
    expect(screen.getByRole('button', { name: 'AI call' })).toBeTruthy();
    expect(screen.getByText('Jane Doe')).toBeTruthy();
  });

  it('posts the record and reports the new AI call', async () => {
    vi.mocked(aiApi.startAiCall).mockResolvedValue({ aiCallId: 'ai-1', status: 'ringing' });
    const onStarted = vi.fn();
    render(<AiCallButton target={LEAD} available onStarted={onStarted} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI call' }));
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith('ai-1'));
    expect(aiApi.startAiCall).toHaveBeenCalledWith({ objectType: 'Lead', recordId: '00Q5e00000AbCdE' });
  });

  it('a 409 shows the block reason in plain words', async () => {
    vi.mocked(aiApi.startAiCall).mockRejectedValue(new ApiError(409, { error: 'no_consent', aiCallId: 'ai-2' }));
    const onStarted = vi.fn();
    render(<AiCallButton target={LEAD} available onStarted={onStarted} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI call' }));
    expect((await screen.findByRole('alert')).textContent)
      .toBe("This record hasn't agreed to AI calls — AI Call Consent is unticked in Salesforce.");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('is disabled while a human call is being placed', () => {
    render(<AiCallButton target={LEAD} available disabled onStarted={() => {}} />);
    expect((screen.getByRole('button', { name: 'AI call' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
