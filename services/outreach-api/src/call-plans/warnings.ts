/**
 * What the AI voice engine's gate will refuse, shown on the plan card before anyone approves.
 * Advisory: the engine re-reads consent and phones at call time and is the only authority.
 */
import { GateWarningCode, type AiConsentStatus, type GateWarning } from '@cti/contracts';
import { CALL_WINDOW, isDailyCapped, withinRecipientWindow, type ConsentBlock } from '@cti/firewall';

export const WARNING_WORDS: Readonly<Record<GateWarningCode, string>> = {
  no_ai_consent: "Can't call: no AI consent in Salesforce.",
  consent_field_missing: "Can't call: this Salesforce org has no AI consent field (AI_Call_Consent__c).",
  consent_unknown: "Can't call: consent could not be read — research again.",
  no_phone: "Can't call: the record has no phone number.",
  opted_out: 'Opted out of calls.',
  blocked: 'On the block list.',
  dnc: 'On the federal Do Not Call list.',
  dnc_pending: "Can't call: a do-not-contact flag on this person is waiting in Needs Review.",
  dnc_not_dismissed: "Can't call: the research flagged this person do-not-contact and nobody has dismissed the flag.",
  sf_do_not_call: "Can't call: Do Not Call is checked in Salesforce.",
  skip_on_dialer: "Can't call: Skip on Dialer is checked in Salesforce.",
  closed: 'The record is closed in Salesforce.',
  state_daily_cap: 'This state limits calls per day; the call may wait for tomorrow.',
  outside_calling_hours: "It's outside calling hours where they live; the call waits until the window opens.",
};

const BLOCK_CODES: Readonly<Record<ConsentBlock, GateWarningCode>> = { opted_out: 'opted_out', blocked: 'blocked', dnc: 'dnc' };
const ORDER = GateWarningCode.options;

export interface WarningInput {
  /** The consent the CURRENT plan's research read; null when nothing was researched yet. */
  consent: AiConsentStatus | null;
  record: { phones: Array<{ field: string; e164: string }>; sfDoNotCall: boolean; skipOnDialer: boolean; isClosed: boolean; state: string | null };
  blocks: ReadonlyMap<string, ConsentBlock>;
  now: Date;
  /** Do-not-contact holds (CF-10). Left out, there are none. */
  dnc?: { pending: boolean; flaggedNotDismissed: boolean };
}

const warn = (code: GateWarningCode, severity: GateWarning['severity'], words = WARNING_WORDS[code]): GateWarning => ({ code, severity, words });

function consentWarnings(consent: AiConsentStatus | null): GateWarning[] {
  if (consent === 'no') return [warn('no_ai_consent', 'block')];
  if (consent === 'field_missing') return [warn('consent_field_missing', 'block')];
  if (consent === 'unknown') return [warn('consent_unknown', 'block')];
  return [];
}

function phoneWarnings(i: WarningInput): GateWarning[] {
  const numbers = [...new Set(i.record.phones.map((p) => p.e164))];
  if (numbers.length === 0) return [warn('no_phone', 'block')];
  const byBlock = new Map<ConsentBlock, number>();
  for (const n of numbers) {
    const b = i.blocks.get(n);
    if (b) byBlock.set(b, (byBlock.get(b) ?? 0) + 1);
  }
  const out = [...byBlock].map(([block, count]) =>
    count === numbers.length
      ? warn(BLOCK_CODES[block], 'block')
      : warn(BLOCK_CODES[block], 'info', `${WARNING_WORDS[BLOCK_CODES[block]]} (one of the numbers)`),
  );
  if (!withinRecipientWindow(numbers[0]!, i.now, CALL_WINDOW)) out.push(warn('outside_calling_hours', 'info'));
  return out;
}

export function gateWarnings(i: WarningInput): GateWarning[] {
  const all = [
    ...consentWarnings(i.consent),
    ...phoneWarnings(i),
    ...(i.dnc?.pending ? [warn('dnc_pending', 'block')] : []),
    ...(i.dnc?.flaggedNotDismissed ? [warn('dnc_not_dismissed', 'block')] : []),
    ...(i.record.sfDoNotCall ? [warn('sf_do_not_call', 'block')] : []),
    ...(i.record.skipOnDialer ? [warn('skip_on_dialer', 'block')] : []),
    ...(i.record.isClosed ? [warn('closed', 'info')] : []),
    ...(isDailyCapped(i.record.state) ? [warn('state_daily_cap', 'info')] : []),
  ];
  return all.sort((a, b) => (a.severity === b.severity ? ORDER.indexOf(a.code) - ORDER.indexOf(b.code) : a.severity === 'block' ? -1 : 1));
}

export const hasBlockingWarning = (w: readonly GateWarning[]): boolean => w.some((x) => x.severity === 'block');
