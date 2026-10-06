/** "Talk in browser" (plan 1E): what a run that ended early says, in words. */

export const NO_RING_WORDS = "The AI didn't ring through. Try again or use Ring my phone.";
export const REGISTER_WORDS = "This browser couldn't connect to the calling service. Try again or use Ring my phone.";
export const CALL_ERROR_WORDS = 'The call dropped. Try again or use Ring my phone.';

/** The name the default microphone check throws when the page is not a secure context (no `navigator.mediaDevices`). */
export const INSECURE_CONTEXT = 'InsecureContextError';

const MIC_DENIED = "The microphone is blocked for this site. Allow it in the browser's site settings, or use Ring my phone.";
const MIC_MISSING = 'No microphone was found. Connect one (headphones with a mic work), or use Ring my phone.';
const MIC_INSECURE = 'The microphone only works on a secure (https) page. Open the app over https, or use Ring my phone.';
const MIC_OTHER = "The microphone couldn't be opened (another app may be using it). Try again, or use Ring my phone.";

const MIC_WORDS: Readonly<Record<string, string>> = {
  NotAllowedError: MIC_DENIED,
  SecurityError: MIC_DENIED,
  NotFoundError: MIC_MISSING,
  OverconstrainedError: MIC_MISSING,
  [INSECURE_CONTEXT]: MIC_INSECURE,
};

/** Why the microphone could not be opened, by the getUserMedia error's name (permission, no device, not https, other). */
export function micErrorWords(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  return MIC_WORDS[name] ?? MIC_OTHER;
}
