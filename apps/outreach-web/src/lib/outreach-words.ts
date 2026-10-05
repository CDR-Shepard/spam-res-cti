import type { CampaignStatus, ContactChannel, DoNotContactCategory, EnrollmentStatus, GateStep, SfObject, SkipReason, TouchChannel, TouchStatus } from '@cti/contracts';
import { ApiRequestError } from './api';

/** `snake_case` code → "Snake case", for codes no table knows yet. */
export function humanize(code: string): string {
  const text = code.replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : code;
}

/** Look a server-sent code up in a word table. Only own keys count, so a code like `constructor` never resolves to `Object.prototype`. */
export function wordFor(table: Readonly<Record<string, string>>, code: string, fallback: string = humanize(code)): string {
  return Object.hasOwn(table, code) ? (table[code] ?? fallback) : fallback;
}

export const CAMPAIGN_STATUS_WORDS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  dry_run: 'Dry run',
  active: 'Live',
  paused: 'Paused',
  archived: 'Archived',
};

export const PAUSE_REASON_WORDS: Readonly<Record<string, string>> = {
  manual: 'Paused by an admin',
  crm_broken: 'Paused: the Salesforce connection needs to be reconnected',
  // Nothing resumes an ai_budget pause automatically (any campaign mode): an admin presses Resume.
  ai_budget: "Paused: today's AI budget is used up — it does not resume on its own: press Resume after midnight UTC or raise the budget",
  kill_switch: 'Paused: outreach is switched off',
};

export function pauseReasonWords(reason: string | null): string {
  return reason ? wordFor(PAUSE_REASON_WORDS, reason, 'Paused') : 'Paused';
}

export const SKIP_REASON_WORDS: Record<SkipReason, string> = {
  no_contact_point: 'No phone or email',
  opted_out: 'Opted out',
  blocked: 'On the block list',
  dnc: 'On the national Do Not Call list',
  sf_do_not_call: 'Salesforce Do Not Call',
  sf_email_opt_out: 'Salesforce Email Opt Out',
  skip_on_dialer: 'Skip on Dialer',
  in_other_campaign: 'Already in another active campaign',
  closed: 'Closed or converted',
};

export const CONTACT_CHANNEL_WORDS: Record<ContactChannel, string> = { call: 'Call', sms: 'Text', email: 'Email' };

export const SF_OBJECT_WORDS: Record<SfObject, string> = { Lead: 'Leads', Opportunity: 'Opportunities' };

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Error codes several outreach pages can hit. Pages pass their own extra codes to `errorText`. */
const COMMON_ERROR_WORDS: Readonly<Record<string, string>> = {
  CRM_NOT_CONNECTED: 'Salesforce is not connected. An admin can connect it in Settings.',
  SALESFORCE_DISABLED: 'Salesforce is not set up on this server yet.',
  ADMIN_ONLY: 'Only admins can do that.',
  CAMPAIGN_NOT_FOUND: 'That campaign does not exist.',
};

export function errorText(error: unknown, extra: Readonly<Record<string, string>> = {}): string {
  if (error instanceof ApiRequestError) return wordFor(extra, error.code, wordFor(COMMON_ERROR_WORDS, error.code, error.message));
  return 'Something went wrong. Try again.';
}

export const ENROLLMENT_STATUS_WORDS: Record<EnrollmentStatus, string> = {
  active: 'In sequence',
  conversing: 'In conversation',
  needs_review: 'Needs review',
  handed_off: 'Handed off',
  completed: 'Finished',
  exited: 'Stopped',
};

/** Exit reasons written by refresh (A8), the planner (A10), and review (A11). */
const EXIT_REASON_WORDS: Readonly<Record<string, string>> = {
  left_query: 'left the Salesforce query',
  closed: 'record closed or converted',
  no_allowed_channel: 'no channel was allowed',
  sequence_complete: 'finished the sequence',
  do_not_contact_confirmed: 'do not contact confirmed',
  opted_out: 'opted out',
  blocked: 'number on the block list',
  dnc: 'on the national Do Not Call list',
  sf_do_not_call: 'Salesforce Do Not Call',
  sf_email_opt_out: 'Salesforce Email Opt Out',
  skip_on_dialer: 'Skip on Dialer',
};

export function enrollmentStatusWords(status: EnrollmentStatus, exitReason: string | null): string {
  const base = ENROLLMENT_STATUS_WORDS[status];
  if (status !== 'exited' || !exitReason) return base;
  return `${base}: ${wordFor(EXIT_REASON_WORDS, exitReason, humanize(exitReason).toLowerCase())}`;
}

export const TOUCH_CHANNEL_WORDS: Record<TouchChannel, string> = { ai_call: 'AI call', rep_call: 'Rep call', sms: 'Text', email: 'Email' };

export const TOUCH_STATUS_WORDS: Record<TouchStatus, string> = {
  planned: 'planned',
  held: 'held until the channel is live',
  queued: "in reps' call list",
  dialing: 'dialing now',
  sent: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

const GATE_CHANNEL_WORDS: Readonly<Record<string, string>> = { ...CONTACT_CHANNEL_WORDS, ...TOUCH_CHANNEL_WORDS };

const GATE_VERDICT_WORDS: Record<GateStep['verdict'], string> = {
  removed: 'ruled out',
  deferred: 'moved later',
  kept: 'kept',
  held: 'held until the channel is live',
};

/**
 * The planner's `channel` is one of the five channels, but also `none` (no channel remained) and
 * comma lists such as `call,sms,email` (the candidate order). Word each part.
 */
function gateChannelWords(channel: string): string {
  if (channel === 'none') return 'No channel';
  return channel.split(',').map((part) => wordFor(GATE_CHANNEL_WORDS, part.trim())).join(', ');
}

/** One planner gate step as a sentence, e.g. "Text ruled out: No mobile number on the record". The planner's `detail` carries the specifics. */
export function gateStepWords(step: GateStep): string {
  const verdict = GATE_VERDICT_WORDS[step.verdict];
  const lead = step.channel ? `${gateChannelWords(step.channel)} ${verdict}` : humanize(verdict);
  return step.detail ? `${lead}: ${step.detail}` : lead;
}

export const DNC_CATEGORY_WORDS: Record<DoNotContactCategory, string> = {
  sold: 'Already sold',
  attorney: 'Has an attorney',
  deceased: 'Deceased',
  asked_no_contact: 'Asked not to be contacted',
  listed_with_agent: 'Listed with an agent',
  hostile: 'Hostile',
  other: 'Other reason',
};
