/**
 * Human-readable catalog of every firewall gate. The backend identifies
 * checks by snake_case name (services/cti-api/src/firewall/index.ts); this
 * maps each one to rep-facing copy and a category so the verdict panel can
 * tell the story: reputation hygiene first, then delivery, then compliance.
 */

export type CheckCategory = 'reputation' | 'delivery' | 'compliance';

export interface CheckMeta {
  /** Short rep-facing label. */
  label: string;
  /** One-line plain-English "why this gate exists". Shown on hover. */
  hint: string;
  category: CheckCategory;
}

export const CATEGORY_ORDER: CheckCategory[] = ['reputation', 'delivery', 'compliance'];

export const CATEGORY_LABEL: Record<CheckCategory, string> = {
  reputation: 'Reputation',
  delivery: 'Delivery',
  compliance: 'Compliance',
};

const CHECK_META: Record<string, CheckMeta> = {
  // --- Reputation hygiene (keeps numbers off "Spam Likely") ---
  warmup: {
    label: 'Number warmup',
    hint: 'Daily dials stay under this number’s age-based cap — fresh DIDs that burst get labeled within 72h.',
    category: 'reputation',
  },
  velocity: {
    label: 'Call velocity',
    hint: 'No autodialer-style burst (10+ calls/min) from this number.',
    category: 'reputation',
  },
  neighbor_spoof: {
    label: 'Neighbor spoofing',
    hint: 'Caller ID doesn’t mimic the recipient’s area code + exchange — carriers penalize tight prefix matches.',
    category: 'reputation',
  },
  answer_rate: {
    label: 'Answer rate',
    hint: 'This number’s recent answer rate is above the ~5% floor — below it, carriers treat it as a dead robocall DID.',
    category: 'reputation',
  },
  engagement: {
    label: 'Engagement',
    hint: 'Connected calls from this number last longer than ~6s — sub-6s averages are the robocall fingerprint.',
    category: 'reputation',
  },
  // --- Delivery (will the call actually ring?) ---
  outbound_number: {
    label: 'Caller ID health',
    hint: 'The outbound number is registered, active, and not flagged by carrier analytics.',
    category: 'delivery',
  },
  attestation: {
    label: 'STIR/SHAKEN',
    hint: 'Carrier is still signing your calls at the baseline attestation level — a downgrade is the first sign of labeling.',
    category: 'delivery',
  },
  // --- Compliance (TCPA / DNC / state law) ---
  phone_parse: {
    label: 'Valid number',
    hint: 'The destination parses to a real, dialable number.',
    category: 'compliance',
  },
  opt_out: {
    label: 'Opt-out list',
    hint: 'The recipient has not asked you to stop calling.',
    category: 'compliance',
  },
  blocklist: {
    label: 'Internal blocklist',
    hint: 'Not manually blocked by your team.',
    category: 'compliance',
  },
  federal_dnc: {
    label: 'Federal DNC',
    hint: 'Not on the National Do-Not-Call registry — violations run $500–$1,500 per call.',
    category: 'compliance',
  },
  rnd: {
    label: 'Reassigned number',
    hint: 'The number hasn’t changed owners since consent was captured (FCC safe harbor).',
    category: 'compliance',
  },
  consent_record: {
    label: 'Consent on file',
    hint: 'TCPA consent evidence for this recipient, if any.',
    category: 'compliance',
  },
  state_rules: {
    label: 'State rules',
    hint: 'Per-state attempt caps and calling windows (FL/OK/MD/NJ mini-TCPAs).',
    category: 'compliance',
  },
  state_registration: {
    label: 'State registration',
    hint: 'Some states (e.g. Texas) require registration + bond before commercial calls.',
    category: 'compliance',
  },
  calling_hours: {
    label: 'Calling hours',
    hint: 'Inside the recipient’s local calling window, derived from their Salesforce address.',
    category: 'compliance',
  },
  attempt_limit: {
    label: 'Attempt limit (per number)',
    hint: 'This number is under the campaign’s per-number attempts-per-window cap for this customer.',
    category: 'compliance',
  },
  customer_limit: {
    label: 'Customer contact ceiling',
    hint: 'Total contacts to this customer across all your numbers are under the per-customer ceiling.',
    category: 'compliance',
  },
  campaign: {
    label: 'Campaign',
    hint: 'An active, unpaused campaign governs this call.',
    category: 'compliance',
  },
  recording_consent: {
    label: 'Recording consent',
    hint: 'Two-party-consent states require a recording disclosure up front.',
    category: 'compliance',
  },
};

export function checkMeta(name: string): CheckMeta {
  return (
    CHECK_META[name] ?? {
      label: name.replace(/_/g, ' '),
      hint: '',
      category: 'compliance',
    }
  );
}
