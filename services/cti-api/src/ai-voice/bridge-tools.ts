/**
 * Running the function calls a Realtime `response.done` carries: in order,
 * one output per call. The batch reports whether the conversation continues —
 * not when any call ends it (`hangup` / `transfer`), because the service will
 * wait for the agent's last words and then act on the call itself — and whether
 * the agent should speak (not when it chose `wait_for_user`). The bridge
 * decides whether to send the one `response.create`, with `followUpAfterTools`.
 */
import { functionCallOutput } from './bridge-session.js';
import { TOOL_NAMES, WAIT_FOR_USER, type ToolName } from './prompt.js';

export interface ToolResult {
  output: string;
  then?: 'hangup' | 'transfer' | 'continue' | 'wait';
}

export interface BatchResult {
  /** False when any call ended the conversation (hangup / transfer). */
  carryOn: boolean;
  /** False when the agent chose to stay quiet (wait_for_user): no response.create. */
  speak: boolean;
  /** An end_call was sent back unrun (BatchOptions.refuseSilentEnd): the agent is to say its goodbye first. */
  refusedSilentEnd?: boolean;
}

export interface BatchOptions {
  /** Send end_call back unrun with the goodbye note; the bridge's goodbye guard decides when, and ends the call after the goodbye. */
  refuseSilentEnd?: boolean;
  /** The output a refused end_call gets (default SAY_GOODBYE_FIRST; outbound calls pass sayGoodbyeWithNumber). */
  goodbyeNote?: string;
}

/** What the response that carried the calls did, as the caller heard it. */
export interface Spoke {
  /** It played audio and was not cut (not truncated, not dropped unheard). */
  audio: boolean;
  /** The last thing it said (its agent transcript, trimmed) ends with a question mark. */
  question: boolean;
}

export interface BridgeLog {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

export interface FunctionCall {
  name: string;
  call_id: string;
  arguments: string;
}

export interface ToolDeps {
  onTool(name: ToolName, args: unknown): Promise<ToolResult>;
  log: BridgeLog;
  send(message: object): void;
}

const BAD_ARGUMENTS = '{"error":"bad arguments"}';
/**
 * What the agent hears when the bridge sends back an end_call that came with no spoken goodbye. It asks for the goodbye
 * only: the bridge ends the call once it is said. A line about silence or end_call was read out loud ("Oh, sorry about
 * that silence. Let me say a quick goodbye...": simulated inbound calls, 2026-10-19).
 */
export const SAY_GOODBYE_FIRST = JSON.stringify({
  ended: false,
  next: 'say only a short goodbye to the caller, with their name if you know it, like: Okay, take care. Bye now.',
});

/**
 * What the agent hears when it ends the call without a word right after the caller asked a question (caller-question.ts).
 * The call goes on and the agent answers them, in a speech-only turn. Like SAY_GOODBYE_FIRST it names no tool and no
 * silence, so there is nothing in it to read out loud.
 */
export const ANSWER_THEM_FIRST = JSON.stringify({
  ended: false,
  next: 'answer what they just said, out loud',
});

/**
 * The outbound guard's note: the same goodbye-only ask, with our callback number spoken in it, because the goodbye
 * after a sent-back end_call kept dropping the number the outbound prompt asks for (simulated outbound calls,
 * 2026-10-19). Without a number it is SAY_GOODBYE_FIRST.
 */
export function sayGoodbyeWithNumber(spokenNumber: string | null): string {
  if (spokenNumber === null) return SAY_GOODBYE_FIRST;
  return JSON.stringify({
    ended: false,
    next:
      'say only a short goodbye to them, with their name if you know it. Unless they asked not to be called, or you already gave it, ' +
      `give our number in it, like: Okay, take care — if anything comes up, you can reach us at ${spokenNumber}. Bye now.`,
  });
}

/** The arguments of a batch's first end_call (`{}` when they don't parse: end_call then records outcome `other`). */
export function endCallArgs(calls: readonly FunctionCall[]): unknown {
  const call = calls.find((c) => c.name === 'end_call');
  try {
    return call ? (JSON.parse(call.arguments) as unknown) : {};
  } catch {
    return {};
  }
}
/** The outcome a batch's first end_call asks for ('' when it has none). */
export function endCallOutcome(calls: readonly FunctionCall[]): string {
  const args = endCallArgs(calls);
  const outcome = args !== null && typeof args === 'object' ? (args as Record<string, unknown>).outcome : undefined;
  return typeof outcome === 'string' ? outcome : '';
}
/** What the model hears for a tool it may not call (an unknown name, or one its call was not offered: service-tools.ts). */
export const UNKNOWN_TOOL = '{"error":"unknown tool"}';
const TOOL_FAILED = '{"error":"tool failed"}';
const LOGGED_NAME_MAX = 64;
const WAITING: ToolResult = { output: '{"ok":true}', then: 'wait' };
/** Silent note saves: the outbound agent's qualification. */
const NOTE_TOOLS: ReadonlySet<string> = new Set<ToolName>(['save_qualification']);

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isToolName = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

function isFunctionCall(v: unknown): v is FunctionCall {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.type === 'function_call' && typeof o.name === 'string' && typeof o.call_id === 'string';
}

/** The function calls in a `response.done` event's `response` object, in order. */
export function functionCalls(response: Record<string, unknown>): FunctionCall[] {
  return Array.isArray(response.output) ? response.output.filter(isFunctionCall) : [];
}

/**
 * Whether the agent speaks again after a tool batch. Not when it chose to stay quiet. Not when the
 * response only saved notes after saying something that ended with a question: the caller has the
 * floor, and a follow-up would talk over their answer. Otherwise yes: a tool-first response (no
 * audio), any other tool (or an unknown one), or a note save whose statement ended without a question.
 */
export function followUpAfterTools(calls: readonly FunctionCall[], batch: BatchResult, spoke: Spoke): boolean {
  if (!batch.speak) return false;
  const onlyNotes = calls.length > 0 && calls.every((call) => NOTE_TOOLS.has(call.name));
  return !(onlyNotes && spoke.audio && spoke.question);
}

/** Run calls in order and send every output (an end_call refused by `opts` is answered, not run). */
export async function runToolBatch(calls: readonly FunctionCall[], deps: ToolDeps, opts: BatchOptions = {}): Promise<BatchResult> {
  let carryOn = true;
  let speak = true;
  let refusedSilentEnd = false;
  for (const call of calls) {
    if (opts.refuseSilentEnd && call.name === 'end_call') {
      refusedSilentEnd = true;
      deps.send(functionCallOutput(call.call_id, opts.goodbyeNote ?? SAY_GOODBYE_FIRST));
      continue;
    }
    const result = await runTool(call, deps);
    deps.send(functionCallOutput(call.call_id, result.output));
    if (result.then === 'hangup' || result.then === 'transfer') carryOn = false;
    if (result.then === 'wait') speak = false;
  }
  return { carryOn, speak, refusedSilentEnd };
}

async function runTool(call: FunctionCall, deps: ToolDeps): Promise<ToolResult> {
  if (call.name === WAIT_FOR_USER) return WAITING;
  if (!isToolName(call.name)) {
    deps.log.warn({ tool: call.name.slice(0, LOGGED_NAME_MAX) }, 'ai-voice bridge: unknown tool');
    return { output: UNKNOWN_TOOL };
  }
  let args: unknown;
  try {
    args = JSON.parse(typeof call.arguments === 'string' ? call.arguments : '');
  } catch {
    deps.log.warn({ tool: call.name }, 'ai-voice bridge: bad tool arguments');
    return { output: BAD_ARGUMENTS };
  }
  try {
    return await deps.onTool(call.name, args);
  } catch (e) {
    deps.log.error({ tool: call.name, err: errText(e) }, 'ai-voice bridge: tool failed');
    return { output: TOOL_FAILED };
  }
}
