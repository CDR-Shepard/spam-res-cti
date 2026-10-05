/**
 * Reading untrusted socket frames: JSON parsing that never throws, and
 * total accessors so a malformed field reads as empty instead of crashing.
 */

export type Msg = Record<string, unknown>;

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const obj = (v: unknown): Msg => (v !== null && typeof v === 'object' ? (v as Msg) : {});

/** A ws frame (string or Buffer) as a JSON object, or null when it is not one. */
export function parseFrame(raw: unknown): Msg | null {
  try {
    const v: unknown = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    return v !== null && typeof v === 'object' ? (v as Msg) : null;
  } catch {
    return null;
  }
}

/** The loggable fields of an OpenAI `error` event (never any audio). */
export function openAiErrorFields(err: Msg): Record<string, string> {
  return { errorType: str(err.type), code: str(err.code), message: str(err.message), param: str(err.param) };
}
