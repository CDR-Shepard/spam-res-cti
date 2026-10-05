import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { TestCallResponse } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { notCalledWords } from '@/lib/call-words';
import { getAiAvailability, outreachKeys, startTestCall } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const PLACED_WORDS = 'Calling now. Pick up to hear the agent.';

const answerWords = (r: TestCallResponse): string => (r.result === 'placed' ? PLACED_WORDS : notCalledWords(r.reason));

/**
 * "Test call to my phone" (admins): the AI agent calls one of the CTI's test numbers. cti-api's gate still decides it
 * (an admin, a number in AI_VOICE_TEST_NUMBERS); the list of numbers comes from cti-api's environment.
 */
export function AiTestCall() {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  if (!isAdmin) return null;
  return <AdminTestCall />;
}

function AdminTestCall() {
  const availability = useQuery({ queryKey: outreachKeys.aiAvailability, queryFn: getAiAvailability });
  const [picked, setPicked] = useState<string | null>(null);
  const call = useMutation({ mutationFn: startTestCall });
  if (availability.isPending || (availability.data && !availability.data.available)) return null;
  const numbers = availability.data?.testNumbers ?? [];
  const to = picked ?? numbers[0] ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Test call to my phone</CardTitle>
        <CardDescription>The AI agent calls one of the CTI's test numbers. Use it each morning before a campaign calls anyone (runbook: AI voice §5).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Not an alert: this card sits beside the Salesforce one, whose problems are the alerts on this page. */}
        {availability.error && <p className="text-sm text-destructive">{errorText(availability.error)}</p>}
        {availability.data && numbers.length === 0 && (
          <p className="text-sm text-muted-foreground">No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.</p>
        )}
        {numbers.length > 0 && to && (
          <div className="flex flex-wrap items-end gap-2">
            <Label className="flex-col items-start">
              Test number
              <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={to} onChange={(e) => setPicked(e.target.value)}>
                {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Label>
            <Button size="sm" disabled={call.isPending} onClick={() => call.mutate(to)}>Test call to my phone</Button>
          </div>
        )}
        {call.data && <p role="status" className="text-sm">{answerWords(call.data)}</p>}
        {call.error && <p role="alert" className="text-sm text-destructive">{errorText(call.error)}</p>}
      </CardContent>
    </Card>
  );
}
