import { useQuery } from '@tanstack/react-query';
import type { TranscriptLine } from '@cti/contracts';
import { getAiCallTranscript, outreachKeys } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const SPEAKER_WORDS: Record<TranscriptLine['role'], string> = { agent: 'AI', caller: 'Them', system: 'Note' };

/** One call's transcript, fetched when the panel opens (the owner of the record or an admin). */
export function AiCallTranscriptPanel({ aiCallId }: { aiCallId: string }) {
  const transcript = useQuery({ queryKey: outreachKeys.aiCallTranscript(aiCallId), queryFn: () => getAiCallTranscript(aiCallId) });
  if (transcript.isPending) return <p className="text-sm text-muted-foreground">Loading the transcript…</p>;
  if (transcript.error) return <p role="alert" className="text-sm text-destructive">{errorText(transcript.error)}</p>;
  if (transcript.data.lines.length === 0) return <p className="text-sm text-muted-foreground">No transcript was recorded for this call.</p>;
  return (
    <ol className="space-y-1.5 rounded-lg bg-muted/60 p-3 text-sm leading-6">
      {transcript.data.lines.map((line, i) => (
        // Lines can repeat word for word ("Yes."), so the index is the key.
        <li key={i} className="grid grid-cols-[3rem_1fr] gap-2">
          <span className="pt-0.5 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">{SPEAKER_WORDS[line.role]}</span>
          <span>{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
