import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import type { RecordTest, RecordTestCall } from '@cti/contracts';
import { StatusBadge } from '@/components/layout/status-badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
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
export function RecordTestRun({ test, onBrowserLive }: { test: RecordTest; onBrowserLive?: (live: boolean) => void }) {
  if (test.status !== 'ready' || !test.planText) return null;
  return <RunControls test={test} onBrowserLive={onBrowserLive} />;
}

function RunControls({ test, onBrowserLive }: { test: RecordTest; onBrowserLive?: (live: boolean) => void }) {
  const qc = useQueryClient();
  const availability = useQuery({ queryKey: outreachKeys.aiAvailability, queryFn: getAiAvailability });
  const [browserBusy, setBrowserBusy] = useState(false);
  useEffect(() => { onBrowserLive?.(browserBusy); }, [browserBusy, onBrowserLive]);
  useEffect(() => () => onBrowserLive?.(false), [onBrowserLive]);
  const liveCall = test.calls.find((c) => isLiveCall(c)) ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: outreachKeys.recordTest(test.id) });
  // Once read, the answer stays: a failed or changed re-read never unmounts a browser call that is up.
  if (availability.isPending) return <p className="text-sm text-muted-foreground">Checking the AI calling service…</p>;
  if (!availability.data) return <p role="alert" className="text-sm text-destructive">{errorText(availability.error)}</p>;
  if (!availability.data.available && !browserBusy) return <p className="text-sm text-muted-foreground">AI calling is off, so test calls can't run right now.</p>;
  return (
    <section aria-label="Run the call" className="space-y-4 rounded-xl border bg-background/70 p-4 text-sm sm:p-5">
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Try the call</h3>
        <p className="text-[13px] leading-5 text-muted-foreground">{HINT}</p>
      </div>
      <PhoneRun testId={test.id} calls={test.calls} numbers={availability.data.testNumbers} disabled={liveCall !== null || browserBusy} onPlaced={refresh} />
      {(availability.data.browserCalls === true || browserBusy) && <BrowserRun testId={test.id} disabled={liveCall !== null} onBusy={setBrowserBusy} onChange={refresh} />}
      {liveCall?.callStatus && <p role="status">{`Your test call: ${CALL_STATUS_WORDS[liveCall.callStatus]}`}</p>}
    </section>
  );
}

/** "Ringing your phone…" only while that call has not been answered or ended; a refusal's words stay. */
function ringWords(answer: { callId: string; response: Parameters<typeof practiceAnswerWords>[0] } | undefined, calls: readonly RecordTestCall[]): string | null {
  if (!answer) return null;
  if (answer.response.result !== 'placed') return practiceAnswerWords(answer.response);
  const call = calls.find((c) => c.id === answer.callId);
  if (!call) return practiceAnswerWords(answer.response);
  const ringing = call.callStatus === null || call.callStatus === 'queued' || call.callStatus === 'ringing';
  return ringing && isLiveCall(call) ? practiceAnswerWords(answer.response) : null;
}

function PhoneRun({ testId, calls, numbers, disabled, onPlaced }: { testId: string; calls: readonly RecordTestCall[]; numbers: readonly string[]; disabled: boolean; onPlaced: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const ring = useMutation({ mutationFn: (to: string) => recordTestCall(testId, { mode: 'phone', to }), onSettled: onPlaced });
  const to = picked ?? numbers[0] ?? null;
  const words = ringWords(ring.data, calls);
  if (!to) return <p className="text-muted-foreground">{NO_NUMBERS}</p>;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <Label className="flex-col items-start gap-1.5">
          Test number
          <NativeSelect value={to} onChange={(e) => setPicked(e.target.value)}>
            {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
          </NativeSelect>
        </Label>
        <Button disabled={disabled || ring.isPending} onClick={() => ring.mutate(to)}><Phone aria-hidden />Ring my phone</Button>
      </div>
      {words && <p role="status">{words}</p>}
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
  const panel = active || phase === 'ended';
  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" disabled={disabled || active || call.supported !== true} onClick={() => void call.start()}><Headphones aria-hidden />Talk in browser</Button>
        <p className="text-xs text-muted-foreground">{HEADPHONES}</p>
      </div>
      {panel && (
        <div className="space-y-4 rounded-xl border bg-card p-4 shadow-[0_1px_2px_rgb(15_15_14/0.04),0_8px_24px_-12px_rgb(15_15_14/0.12)] sm:p-5">
          {phase === 'live' && <StatusBadge tone="live">Live</StatusBadge>}
          <BrowserPhase state={call.state} />
          {active && (
            <div className="flex flex-wrap gap-2">
              {call.state.phase === 'live' && (
                <Button variant={call.state.muted ? 'secondary' : 'outline'} aria-pressed={call.state.muted} onClick={call.toggleMute}>
                  {call.state.muted ? <MicOff aria-hidden /> : <Mic aria-hidden />}Mute
                </Button>
              )}
              <Button variant="destructive" onClick={call.hangUp}><PhoneOff aria-hidden />Hang up</Button>
            </div>
          )}
        </div>
      )}
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
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-foreground motion-reduce:animate-none" />
      <p role="status">{PHASE_WORDS[state.phase]}</p>
    </div>
  );
}

function LiveTimer({ since, muted }: { since: number; muted: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - since) / 1_000));
  // Only the state is a live region: a screen reader hears "Connected" and "muted", never the clock every second.
  // The clock reads after the state (and the " · " between them), but shows big above it.
  return (
    <p className="flex flex-col-reverse items-start gap-1">
      <span role="status" className="text-[13px] font-medium text-muted-foreground">{muted ? 'Connected · muted' : 'Connected'}</span>
      <span aria-hidden className="hidden">{' · '}</span>
      <span aria-live="off" className="text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>
    </p>
  );
}
