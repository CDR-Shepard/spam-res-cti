import type { DialOutcome } from './outcome.js';

/** Map Twilio AMD AnsweredBy → dialer outcome. Bias to human: only an explicit
 *  machine/fax verdict is a miss; unknown/undefined counts as a live human. */
export function mapAnsweredBy(answeredBy: string | undefined): Extract<DialOutcome, 'connected' | 'voicemail' | 'fax'> {
  const a = (answeredBy ?? '').toLowerCase();
  if (a.startsWith('machine')) return 'voicemail';
  if (a === 'fax') return 'fax';
  return 'connected';
}
