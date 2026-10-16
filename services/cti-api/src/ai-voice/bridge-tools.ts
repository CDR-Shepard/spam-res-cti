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
/** What the model hears for a tool it may not call (an unknown name, or one its call was not offered: service-tools.ts). */
export const UNKNOWN_TOOL = '{"error":"unknown tool"}';
const TOOL_FAILED = '{"error":"tool failed"}';
const LOGGED_NAME_MAX = 64;
const WAITING: ToolResult = { output: '{"ok":true}', then: 'wait' };
/** Silent note saves: the outbound agent's qualification, the inbound agent's caller details. */
const NOTE_TOOLS: ReadonlySet<string> = new Set<ToolName>(['save_qualification', 'save_caller_details']);

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
 * floor, and a follow-up would talk over their answer. Otherwise yes: a tool-first response, any
 * other tool (or an unknown one), or a statement that ends without a question.
 */
export function followUpAfterTools(calls: readonly FunctionCall[], batch: BatchResult, spoke: Spoke): boolean {
  if (!batch.speak) return false;
  const onlyNotes = calls.length > 0 && calls.every((call) => NOTE_TOOLS.has(call.name));
  return !(onlyNotes && spoke.audio && spoke.question);
}

/** Run calls in order and send every output. */
export async function runToolBatch(calls: readonly FunctionCall[], deps: ToolDeps): Promise<BatchResult> {
  let carryOn = true;
  let speak = true;
  for (const call of calls) {
    const result = await runTool(call, deps);
    deps.send(functionCallOutput(call.call_id, result.output));
    if (result.then === 'hangup' || result.then === 'transfer') carryOn = false;
    if (result.then === 'wait') speak = false;
  }
  return { carryOn, speak };
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
