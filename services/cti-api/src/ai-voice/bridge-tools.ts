/**
 * Running the function calls a Realtime `response.done` carries: in order,
 * one output per call, then at most one `response.create` — and none when any
 * call ends the conversation (`hangup` / `transfer`), because the service will
 * wait for the agent's last words and then act on the call itself.
 */
import { functionCallOutput } from './bridge-session.js';
import { TOOL_NAMES, type ToolName } from './prompt.js';

export interface ToolResult {
  output: string;
  then?: 'hangup' | 'transfer' | 'continue';
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
const UNKNOWN_TOOL = '{"error":"unknown tool"}';
const TOOL_FAILED = '{"error":"tool failed"}';
const LOGGED_NAME_MAX = 64;

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

/** Run calls in order, send every output, then at most one `response.create`. */
export async function runToolBatch(calls: readonly FunctionCall[], deps: ToolDeps): Promise<void> {
  let carryOn = true;
  for (const call of calls) {
    const result = await runTool(call, deps);
    deps.send(functionCallOutput(call.call_id, result.output));
    if (result.then === 'hangup' || result.then === 'transfer') carryOn = false;
  }
  if (carryOn) deps.send({ type: 'response.create' });
}

async function runTool(call: FunctionCall, deps: ToolDeps): Promise<ToolResult> {
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
