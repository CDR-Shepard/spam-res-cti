/**
 * The built-in default voicemail `<Say>` text (≈ 20 s), as a Mustache template over the view in
 * prompt-view.ts (placeholders: PLACEHOLDERS.voicemail in prompt-template.ts). It renders byte for byte
 * the text voicemailText built before it became a template (pinned by __fixtures__/prompt-golden.json).
 *
 * Who (an AI assistant for the company), why (the property, by street when known), that a team member
 * will call back, and — last, as TCPA requires (47 CFR 64.1200(b)(2)) — the number to reach us on when
 * there is one. No price, no ZIP code.
 */
export const DEFAULT_VOICEMAIL_TEMPLATE =
  'Hi{{#first_name}} {{first_name}}{{/first_name}}, this is {{agent_name}}, an AI assistant calling for {{company_name}} about {{your_property}}. Someone from our team will call you back soon.{{#callback_number}} Thanks! You can reach us at {{callback_number}}.{{/callback_number}}{{^callback_number}} Thanks, and have a great day!{{/callback_number}}';
