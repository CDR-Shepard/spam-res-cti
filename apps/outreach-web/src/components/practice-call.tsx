import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CallPlanCard, PracticeCallsResponse, TestCallResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { useAuth } from '@/lib/auth';
import { practiceStatusWords } from '@/lib/call-words';
import { getAiAvailability, outreachKeys, practiceCall, practiceCalls } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const HINT = "You'll hear exactly what the seller would hear. Nothing is written to Salesforce.";
const FOLLOW_MS = 5_000;
const LIVE: ReadonlySet<string> = new Set(['queued', 'ringing', 'in_progress', 'transferring']);
const NO_NUMBERS = 'No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.';

/**
 * "Practice call to my phone" (admins, plan 1D): the AI agent rings one of the CTI's test numbers as if it were this seller,
 * with the real record and this card's plan (proposed or approved), and the appointment owner's real free times. It never
 * books, converts or writes anything in Salesforce, and it never approves the plan.
 */
export function PracticeCall({ card, campaignId = null }: { card: CallPlanCard; campaignId?: string | null }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin || !card.plan) return null;
  return <AdminPracticeCall enrollmentId={card.enrollmentId} version={card.plan.version} campaignId={campaignId} />;
}

/** While a placed practice call is not on the list yet, or still live: read the list again (it shares the list card's cache). */
function followInterval(data: PracticeCallsResponse | undefined, aiCallId: string): number | false {
  const call = data?.items.find((i) => i.aiCallId === aiCallId);
  return !call || call.callStatus === null || LIVE.has(call.callStatus) ? FOLLOW_MS : false;
}

/** What happened to the call this button placed: ringing, on the call, or how it ended (final review). */
function PracticeStatus({ answer, campaignId }: { answer: TestCallResponse; campaignId: string | null }) {
  const placed = answer.result === 'placed' ? answer.aiCallId : null;
  const list = useQuery({
    queryKey: outreachKeys.practiceCalls(campaignId ?? ''),
    queryFn: () => practiceCalls(campaignId!),
    enabled: campaignId !== null && placed !== null,
    refetchInterval: (q) => (placed === null ? false : followInterval(q.state.data, placed)),
  });
  const call = placed === null ? undefined : list.data?.items.find((i) => i.aiCallId === placed);
  return <p role="status">{practiceStatusWords(answer, call)}</p>;
}

function AdminPracticeCall({ enrollmentId, version, campaignId }: { enrollmentId: string; version: number; campaignId: string | null }) {
  const qc = useQueryClient();
  const availability = useQuery({ queryKey: outreachKeys.aiAvailability, queryFn: getAiAvailability });
  const [picked, setPicked] = useState<string | null>(null);
  const call = useMutation({
    mutationFn: (to: string) => practiceCall(enrollmentId, { version, to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: outreachKeys.practiceCallLists }),
  });
  // AI calling off or unreachable: the Settings page says so; the board stays quiet.
  if (!availability.data?.available) return null;
  const numbers = availability.data.testNumbers;
  const to = picked ?? numbers[0] ?? null;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      {numbers.length === 0 || !to ? (
        <p className="text-muted-foreground">{NO_NUMBERS}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Label className="flex-col items-start gap-1.5">
            Test number
            <NativeSelect value={to} onChange={(e) => setPicked(e.target.value)}>
              {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
            </NativeSelect>
          </Label>
          <Button size="sm" variant="outline" disabled={call.isPending} onClick={() => call.mutate(to)}>Practice call to my phone</Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{HINT}</p>
      {call.data && <PracticeStatus answer={call.data} campaignId={campaignId} />}
      {call.error && <p role="alert" className="text-destructive">{errorText(call.error)}</p>}
    </div>
  );
}
