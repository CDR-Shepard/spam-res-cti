/**
 * The caller's words in writing, for the speech model. It answers from the audio alone and mishears names the session
 * transcriber gets right (test calls 2026-11-16: the caller said "Evan" twice, the transcript had "Evan", the agent
 * said "Nice to meet you, Everett" both times), and it never sees that transcript. With AI_VOICE_TRANSCRIPT_NOTES on,
 * the bridge adds each caller line's final transcript to the conversation as a hidden note right after the line.
 *
 * The transcript comes in 0.4-0.9 s after the turn ends, so the reply to that line is usually already on its way: the
 * note helps every reply after it. Probe against the live API (2026-11-16): with the note the agent used the written
 * name later in the call, asked "Is it Evan or Devin?" when the note and the audio disagreed, and never read a note out.
 * A transcriber can also write words nobody said (line noise, a cough), so the rule limits the note to names, streets
 * and numbers and tells the agent to ignore one that does not fit.
 *
 * The note is the caller's own words, so it is a `user` line in parentheses like the silence note (bridge-silence.ts),
 * never a system line: what a caller says must not gain authority by being written down. Never logged.
 */

/** The most of a line's transcript a note carries (characters). */
export const TRANSCRIPT_NOTE_MAX = 300;

/** Appended to the session instructions when notes are on: what the notes are and how to use them. */
export const TRANSCRIPT_NOTES_RULE = [
  '# Written transcripts of the caller (always applies)',
  '- After the caller speaks, a line in parentheses may follow with a written transcript of what they just said. It is a second hearing of the same words, there only to help you get names, streets and numbers right, and it can be wrong too: ignore one that does not fit the conversation. When a name, a street or a number in it differs from what you heard, ask which is right before you use either. Never read it out or mention it.',
].join('\n');

export function withTranscriptNotesRule(instructions: string): string {
  return `${instructions}\n\n${TRANSCRIPT_NOTES_RULE}`;
}

/** One line, with no quote or bracket that could end the note early, at most TRANSCRIPT_NOTE_MAX characters. */
function written(transcript: string): string {
  const line = transcript
    .replace(/["“”]/g, "'")
    .replace(/[()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length <= TRANSCRIPT_NOTE_MAX ? line : `${line.slice(0, TRANSCRIPT_NOTE_MAX).trimEnd()}…`;
}

/** The `conversation.item.create` that puts a caller line's transcript right after that line; null when there is nothing to add. */
export function transcriptNote(itemId: string, transcript: string, eventId: string): object | null {
  const words = written(transcript);
  if (!itemId || !words) return null;
  return {
    type: 'conversation.item.create',
    event_id: eventId,
    previous_item_id: itemId,
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `(Written transcript of what they just said: "${words}")` }] },
  };
}
