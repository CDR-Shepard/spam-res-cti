/**
 * The OpenAI Realtime (GA) client messages the bridge sends that carry
 * configuration or fixed text, kept apart from the socket plumbing.
 */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type VadEagerness = 'low' | 'medium' | 'high' | 'auto';

export interface SessionSettings {
  model: string;
  voice: string;
  instructions: string;
  tools: readonly unknown[];
  reasoningEffort: ReasoningEffort;
  vadEagerness: VadEagerness;
}

/** Only the gpt-realtime-2 family accepts `session.reasoning`. */
const REASONING_MODEL_PREFIX = 'gpt-realtime-2';
const AUDIO_FORMAT = { type: 'audio/pcmu' } as const;
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export const OPENER_PROMPT = '(The person picked up but has not spoken yet. Open the call now.)';

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
          transcription: { model: TRANSCRIPTION_MODEL, language: 'en' },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: s.vadEagerness,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format: AUDIO_FORMAT, voice: s.voice },
      },
      tools: s.tools,
      tool_choice: 'auto',
    },
  };
}

export function openerItem(): object {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: OPENER_PROMPT }],
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
