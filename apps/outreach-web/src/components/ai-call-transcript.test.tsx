import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { AiCallTurnStats } from '@cti/contracts';
import { turnStatsWords } from '@/lib/call-words';
import { renderWithProviders } from '../test/render';
import { stubApi } from '../test/stub-api';
import { AiCallTranscriptPanel } from './ai-call-transcript';

afterEach(() => vi.unstubAllGlobals());

const CALL = '99999999-9999-4999-8999-999999999999';
const ROUTE = `GET /api/ai-calls/${CALL}/transcript`;
const STATS: AiCallTurnStats = {
  v: 1, bargeIn: 'gate', turns: 4, totalMs: { p50: 1900, p90: 2600, max: 3100 }, endpointMs: { p50: 1100 }, answerMs: { p50: 800 },
  interruptions: 1, listening: 4, silenceChecks: 0,
};
const LINES = [{ role: 'agent', text: 'Hi, this is an AI assistant.', at: null }];

describe('AiCallTranscriptPanel', () => {
  it('shows the turn stats line above the transcript', async () => {
    stubApi({ [ROUTE]: { aiCallId: CALL, lines: LINES, turnStats: STATS } });
    renderWithProviders(<AiCallTranscriptPanel aiCallId={CALL} />);
    const line = await screen.findByText(turnStatsWords(STATS)!);
    expect(line).toHaveTextContent('Response time: usually 1.9 s (slowest 3.1 s) · kept talking through 4 "mm-hmm"s · stopped for 1 interruption');
    const text = screen.getByText('Hi, this is an AI assistant.');
    // The line sits before the transcript list in the document.
    expect(line.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no stats line for a call made before turn stats existed', async () => {
    stubApi({ [ROUTE]: { aiCallId: CALL, lines: LINES, turnStats: null } });
    renderWithProviders(<AiCallTranscriptPanel aiCallId={CALL} />);
    expect(await screen.findByText('Hi, this is an AI assistant.')).toBeInTheDocument();
    expect(screen.queryByText(/Response time/)).not.toBeInTheDocument();
    expect(screen.queryByText(/mm-hmm/)).not.toBeInTheDocument();
  });

  it('keeps the "no transcript" message when there are no lines', async () => {
    stubApi({ [ROUTE]: { aiCallId: CALL, lines: [], turnStats: STATS } });
    renderWithProviders(<AiCallTranscriptPanel aiCallId={CALL} />);
    expect(await screen.findByText('No transcript was recorded for this call.')).toBeInTheDocument();
    expect(screen.queryByText(/Response time/)).not.toBeInTheDocument();
  });
});
