/**
 * The OpenAI Realtime (GA) client messages the bridge sends that carry
 * configuration or fixed text, kept apart from the socket plumbing.
 */

import type { BargeInMode } from './bridge-turn-stats.js';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type VadEagerness = 'low' | 'medium' | 'high' | 'auto';
/** What ends the caller's turn: `server_vad` = a silence of `silenceMs`; `semantic_vad` = OpenAI's "complete thought" model. */
export type TurnDetection = 'server_vad' | 'semantic_vad';

/** What a bare BridgeOptions uses, so a bridge that is not told behaves as it did before these settings existed. */
export const DEFAULT_TURN_DETECTION: TurnDetection = 'semantic_vad';
export const DEFAULT_SILENCE_MS = 500;

/** The settings that shape `turn_detection` (`vadEagerness` applies to semantic_vad only, `silenceMs` to server_vad only). */
export interface TurnDetectionSettings {
  vadEagerness: VadEagerness;
  turnDetection: TurnDetection;
  silenceMs: number;
}

export interface SessionSettings extends TurnDetectionSettings {
  model: string;
  voice: string;
  instructions: string;
  tools: readonly unknown[];
  reasoningEffort: ReasoningEffort;
  bargeIn: BargeInMode;
  transcribeModel: string;
}

/** Only the gpt-realtime-2 family accepts `session.reasoning`. */
const REASONING_MODEL_PREFIX = 'gpt-realtime-2';
const AUDIO_FORMAT = { type: 'audio/pcmu' } as const;

export const OPENER_PROMPT = '(The person picked up but has not spoken yet. Open the call now.)';

/**
 * How the agent opens a call nobody has spoken on yet: after `delayMs` of silence from `session.updated` it is sent
 * `prompt` and answers. Absent (BridgeOptions.opener) = an outbound call: OPENER_DELAY_MS (bridge.ts) and OPENER_PROMPT.
 */
export interface OpenerOption {
  delayMs: number;
  prompt: string;
}

/** An inbound call (a test phone called the AI, plan 2026-10-16): the caller is waiting, so answer almost at once. */
export const INBOUND_OPENER: OpenerOption = {
  delayMs: 300,
  prompt: '(Someone just called in and the line is open. Answer now with your greeting.)',
};

/**
 * The session's turn detection. `createResponse: false` stops the server starting a response when the caller stops
 * talking; `interruptResponse: false` leaves cutting the agent to the bridge's gate (spec 2026-10-09 §4.1).
 */
function turnDetection(s: TurnDetectionSettings, createResponse: boolean, interruptResponse: boolean): object {
  if (s.turnDetection === 'server_vad') {
    return {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: s.silenceMs,
      create_response: createResponse,
      interrupt_response: interruptResponse,
    };
  }
  return { type: 'semantic_vad', eagerness: s.vadEagerness, create_response: createResponse, interrupt_response: interruptResponse };
}

export function sessionUpdate(s: SessionSettings): object {
  const reasoning = s.model.startsWith(REASONING_MODEL_PREFIX) ? { reasoning: { effort: s.reasoningEffort } } : {};
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      model: s.model,
      output_modalities: ['audio'],
      instructions: s.instructions,
      ...reasoning,
      audio: {
        input: {
          format: AUDIO_FORMAT,
          noise_reduction: { type: 'near_field' },
          transcription: { model: s.transcribeModel, language: 'en' },
          turn_detection: s.bargeIn === 'gate' ? turnDetection(s, false, false) : turnDetection(s, true, true),
        },
        output: { format: AUDIO_FORMAT, voice: s.voice },
      },
      tools: s.tools,
      tool_choice: 'auto',
    },
  };
}

/**
 * Sent once the call is closing (hangup / transfer): the same turn detection
 * with `create_response: false`, so the caller talking during the final
 * playback drain cannot start a new agent response.
 */
export function stopAutoResponses(s: TurnDetectionSettings): object {
  return {
    type: 'session.update',
    session: { type: 'realtime', audio: { input: { turn_detection: turnDetection(s, false, true) } } },
  };
}

export function openerItem(prompt: string = OPENER_PROMPT): object {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    },
  };
}

export function functionCallOutput(callId: string, output: string): object {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output },
  };
}

export function truncate(itemId: string, audioEndMs: number): object {
  return {
    type: 'conversation.item.truncate',
    item_id: itemId,
    content_index: 0,
    audio_end_ms: audioEndMs,
  };
}
