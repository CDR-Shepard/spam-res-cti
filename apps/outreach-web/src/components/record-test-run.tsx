import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { RecordTest } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useBrowserCall, type BrowserCallState } from '@/lib/browser-call';
import { CALL_STATUS_WORDS, practiceAnswerWords } from '@/lib/call-words';
import { getAiAvailability, outreachKeys, recordTestCall } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { recordTestErrorText } from '@/lib/record-test-words';
import { isLiveCall } from './record-test-calls';

const HINT = 'Exactly the call the seller would get, with the real record, plan and times. Nothing is written to Salesforce; a booking is only shown here.';
const HEADPHONES = "Use headphones so the AI doesn't hear itself. You are the seller.";
const NO_NUMBERS = 'No test numbers are set. Add yours to AI_VOICE_TEST_NUMBERS on the CTI API service.';

/**
 * Run a ready preview (plan 1E, spec §4.3): Ring my phone (a test number) or Talk in browser (the AI calls this tab).
 * Only when the plan text passed the check; both are off while one of the admin's test calls is live.
 */
export function RecordTestRun({ test }: { test: RecordTest }) {
  if (test.status !== 'ready' || !test.planText) return null;
  return <RunControls test={test} />;
}

function RunControls({ test }: { test: RecordTest }) {
  const qc = useQueryClient();
  const availability = useQuery({ queryKey: outreachKeys.aiAvailability, queryFn: getAiAvailability });
  const [browserBusy, setBrowserBusy] = useState(false);
  const liveCall = test.calls.find((c) => isLiveCall(c)) ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: outreachKeys.recordTest(test.id) });
  if (availability.isPending) return <p className="text-sm text-muted-foreground">Checking the AI calling service…</p>;
  if (availability.error) return <p role="alert" className="text-sm text-destructive">{errorText(availability.error)}</p>;
  if (!availability.data.available) return <p className="text-sm text-muted-foreground">AI calling is off, so test calls can't run right now.</p>;
  return (
    <section aria-label="Run the call" className="space-y-3 rounded-md border p-3 text-sm">
      <h3 className="font-medium">Try the call</h3>
      <p className="text-xs text-muted-foreground">{HINT}</p>
      <PhoneRun testId={test.id} numbers={availability.data.testNumbers} disabled={liveCall !== null || browserBusy} onPlaced={refresh} />
      {availability.data.browserCalls === true && <BrowserRun testId={test.id} disabled={liveCall !== null} onBusy={setBrowserBusy} onChange={refresh} />}
      {liveCall?.callStatus && <p role="status">{`Your test call: ${CALL_STATUS_WORDS[liveCall.callStatus]}`}</p>}
    </section>
  );
}

function PhoneRun({ testId, numbers, disabled, onPlaced }: { testId: string; numbers: readonly string[]; disabled: boolean; onPlaced: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const ring = useMutation({ mutationFn: (to: string) => recordTestCall(testId, { mode: 'phone', to }), onSettled: onPlaced });
  const to = picked ?? numbers[0] ?? null;
  if (!to) return <p className="text-muted-foreground">{NO_NUMBERS}</p>;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <Label className="flex-col items-start">
          Test number
          <select className="h-9 rounded-md border bg-transparent px-2 text-sm" value={to} onChange={(e) => setPicked(e.target.value)}>
            {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Label>
        <Button size="sm" disabled={disabled || ring.isPending} onClick={() => ring.mutate(to)}>Ring my phone</Button>
      </div>
      {ring.data && <p role="status">{practiceAnswerWords(ring.data.response)}</p>}
      {ring.error && <p role="alert" className="text-destructive">{recordTestErrorText(ring.error)}</p>}
    </div>
  );
}

const ACTIVE: ReadonlySet<BrowserCallState['phase']> = new Set(['mic', 'registering', 'placing', 'ringing', 'live']);

const PHASE_WORDS: Readonly<Record<string, string>> = {
  mic: 'Asking for the microphone…',
  registering: 'Connecting this browser…',
  placing: 'Asking the AI to call…',
  ringing: 'The AI is calling this browser…',
};

const ENDED_WORDS: Readonly<Record<string, string>> = { hung_up: 'You hung up.', remote: 'The call ended.' };

function BrowserRun({ testId, disabled, onBusy, onChange }: { testId: string; disabled: boolean; onBusy: (busy: boolean) => void; onChange: () => void }) {
  const call = useBrowserCall(testId);
  const phase = call.state.phase;
  const active = ACTIVE.has(phase);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => { onBusy(active); }, [active, onBusy]);
  // Read the test again as the call is placed, answered and ended, so its card follows.
  useEffect(() => { if (phase === 'ringing' || phase === 'live' || phase === 'ended') changed.current(); }, [phase]);
  if (call.supported === false) return null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={disabled || active || call.supported !== true} onClick={() => void call.start()}>Talk in browser</Button>
        {call.state.phase === 'live' && (
          <Button size="sm" variant="outline" onClick={call.toggleMute}>{call.state.muted ? 'Unmute' : 'Mute'}</Button>
        )}
        {active && <Button size="sm" variant="destructive" onClick={call.hangUp}>Hang up</Button>}
      </div>
      <p className="text-xs text-muted-foreground">{HEADPHONES}</p>
      <BrowserPhase state={call.state} />
    </div>
  );
}

function BrowserPhase({ state }: { state: BrowserCallState }) {
  if (state.phase === 'idle') return null;
  if (state.phase === 'live') return <LiveTimer since={state.since} muted={state.muted} />;
  if (state.phase === 'ended') {
    const words = state.words ?? ENDED_WORDS[state.reason] ?? 'The call ended.';
    return <p role={state.reason === 'hung_up' || state.reason === 'remote' ? 'status' : 'alert'} className={state.words ? 'text-destructive' : undefined}>{words}</p>;
  }
  return <p role="status">{PHASE_WORDS[state.phase]}</p>;
}

function LiveTimer({ since, muted }: { since: number; muted: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1_000));
  return <p role="status">{`Connected · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${muted ? ' · muted' : ''}`}</p>;
}
