import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CallPlanCard } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { practiceAnswerWords } from '@/lib/call-words';
import { getAiAvailability, outreachKeys, practiceCall } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const HINT = "You'll hear exactly what the seller would hear. Nothing is written to Salesforce.";
const NO_NUMBERS = 'No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.';

/**
 * "Practice call to my phone" (admins, plan 1D): the AI agent rings one of the CTI's test numbers as if it were this seller,
 * with the real record and this card's plan (proposed or approved), and the appointment owner's real free times. It never
 * books, converts or writes anything in Salesforce, and it never approves the plan.
 */
export function PracticeCall({ card }: { card: CallPlanCard }) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin || !card.plan) return null;
  return <AdminPracticeCall enrollmentId={card.enrollmentId} version={card.plan.version} />;
}

function AdminPracticeCall({ enrollmentId, version }: { enrollmentId: string; version: number }) {
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
    <div className="space-y-2 rounded-md border p-3">
      {numbers.length === 0 || !to ? (
        <p className="text-muted-foreground">{NO_NUMBERS}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Label className="flex-col items-start">
            Test number
            <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={to} onChange={(e) => setPicked(e.target.value)}>
              {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Label>
          <Button size="sm" variant="outline" disabled={call.isPending} onClick={() => call.mutate(to)}>Practice call to my phone</Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{HINT}</p>
      {call.data && <p role="status">{practiceAnswerWords(call.data)}</p>}
      {call.error && <p role="alert" className="text-destructive">{errorText(call.error)}</p>}
    </div>
  );
}
