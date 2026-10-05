/** Caps on what research reads for one lead. Each source keeps its MOST RECENT items. */
export const RESEARCH_LIMITS = {
  /** Fields selected from the lead's own record (after dropping binary and compound types). */
  recordFields: 300,
  /** Fields per related record. */
  relatedFields: 120,
  relatedRecords: 6,
  fieldValueChars: 1_000,
  tasks: 25,
  events: 10,
  notes: 10,
  contentNotes: 10,
  noteChars: 3_000,
  emails: 10,
  emailChars: 2_000,
  feedItems: 25,
  feedComments: 50,
  feedChars: 1_500,
  commentChars: 600,
  /** The whole snapshot, as JSON. Oldest activity is dropped first to fit. */
  totalChars: 40_000,
} as const;

/** Describe types never selected: binary, compound (their parts are selected instead), and masked values. */
export const SKIPPED_FIELD_TYPES: ReadonlySet<string> = new Set(['base64', 'address', 'location', 'encryptedstring']);
