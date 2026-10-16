import { useState } from 'react';
import type { InboundTestCall } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/outreach-words';
import { callDurationWords, callerWords, inboundBadge, inboundDetailRows } from '@/lib/testing-words';
import { AiCallTranscriptPanel } from './ai-call-transcript';
import { StatusBadge } from './layout/status-badge';

/** One inbound test call: when, who, how long, how it ended, what the agent saved, and its transcript on demand. */
export function InboundCallItem({ call }: { call: InboundTestCall }) {
  const [open, setOpen] = useState(false);
  const badge = inboundBadge(call);
  const details = inboundDetailRows(call.details);
  const caller = callerWords(call);
  return (
    <li aria-label={`${caller}, ${formatDateTime(call.startedAt)}`} className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-medium">{caller}</span>
        <StatusBadge tone={badge.tone}>{badge.words}</StatusBadge>
        <span className="text-sm text-muted-foreground">{formatDateTime(call.startedAt)}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{callDurationWords(call.durationSeconds)}</span>
      </div>
      {details.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {details.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>{open ? 'Hide transcript' : 'Transcript'}</Button>
      {open && <AiCallTranscriptPanel aiCallId={call.id} />}
    </li>
  );
}
