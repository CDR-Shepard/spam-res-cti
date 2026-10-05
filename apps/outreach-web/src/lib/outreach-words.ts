import type { CampaignStatus, ContactChannel, SfObject, SkipReason } from '@cti/contracts';
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
  ai_budget: "Paused: today's AI budget is used up — resumes tomorrow",
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
