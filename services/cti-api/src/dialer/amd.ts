/** Map Twilio AMD AnsweredBy → dialer outcome. Bias to human: only an explicit
 *  machine/fax is a no-connect; unknown/undefined counts as a live human. */
export function mapAnsweredBy(answeredBy: string | undefined): 'connected' | 'no_connect' {
  const a = (answeredBy ?? '').toLowerCase();
  if (a.startsWith('machine') || a === 'fax') return 'no_connect';
  return 'connected';
}
