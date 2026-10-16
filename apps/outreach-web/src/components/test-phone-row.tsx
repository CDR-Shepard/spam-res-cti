import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TestCallResponse, TestPhone } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { notCalledWords } from '@/lib/call-words';
import { outreachKeys, removeTestPhone, startTestCall } from '@/lib/outreach-api';
import { errorText, formatDateTime } from '@/lib/outreach-words';
import { formatPhone, phoneName, phoneWho } from '@/lib/testing-words';
import { ConfirmAction } from './confirm-action';

const answerWords = (phone: TestPhone, r: TestCallResponse): string =>
  r.result === 'placed' ? `Calling ${phoneName(phone)} now. Pick up to hear the agent.` : notCalledWords(r.reason);

const addedWords = (phone: TestPhone): string =>
  phone.addedByEmail ? `Added by ${phone.addedByEmail} · ${formatDateTime(phone.createdAt)}` : `Added ${formatDateTime(phone.createdAt)}`;

/**
 * One phone on the list: its number, label and who added it; "Call this phone" has the agent ring it (the same test call as
 * everywhere else, so cti-api's gate still decides), and Remove takes it off after asking.
 */
export function TestPhoneRow({ phone }: { phone: TestPhone }) {
  const qc = useQueryClient();
  const call = useMutation({ mutationFn: () => startTestCall(phone.e164) });
  const remove = useMutation({
    mutationFn: () => removeTestPhone(phone.id),
    // The other test-call cards (Test call to my phone, Practice, Test a record) list the same phones.
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: outreachKeys.testPhones }), qc.invalidateQueries({ queryKey: outreachKeys.aiAvailability })]),
  });
  const who = phoneWho(phone);
  return (
    <li aria-label={who} className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-0.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium tabular-nums">{formatPhone(phone.e164)}</span>
            {phone.label && <span className="text-sm">{phone.label}</span>}
          </p>
          <p className="text-xs text-muted-foreground">{addedWords(phone)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" aria-label={`Call this phone: ${who}`} disabled={call.isPending} onClick={() => call.mutate()}>Call this phone</Button>
          <ConfirmAction
            label="Remove"
            triggerAriaLabel={`Remove ${who}`}
            triggerVariant="outline"
            title="Remove this phone?"
            description={`${who} stops getting test calls from the agent, and when it calls one of the agent's numbers it is handled like any other caller.`}
            confirmLabel="Remove"
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      </div>
      {call.data && <p role="status" className="text-sm">{answerWords(phone, call.data)}</p>}
      {call.error && <p role="alert" className="text-sm text-destructive">{errorText(call.error)}</p>}
      {remove.error && <p role="alert" className="text-sm text-destructive">{errorText(remove.error)}</p>}
    </li>
  );
}
