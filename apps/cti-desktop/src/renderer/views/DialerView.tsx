import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CallScreen } from '../components/CallScreen';
import { Dialpad } from '../components/Dialpad';
import { VerdictPanel, type FirewallVerdict } from '../components/VerdictPanel';
import { WrapupForm } from '../components/WrapupForm';
import { formatE164 } from '../format';
import { useApp } from '../state';

type Phase = 'idle' | 'preflight' | 'ringing' | 'active' | 'wrapup';

interface ActiveCallState {
  callId: string;
  toNumber: string;
  fromNumber: string;
  startedAt: number;
}

interface OutboundNumber { id: string; e164: string; label: string | null; active: boolean; health: string }

export function DialerView(): JSX.Element {
  const { setToast, incomingTel } = useApp();
  const [raw, setRaw] = useState('');
  const [firewall, setFirewall] = useState<FirewallVerdict | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [busy, setBusy] = useState(false);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [disposition, setDisposition] = useState('Connected');
  const [notes, setNotes] = useState('');
  const [outbound, setOutbound] = useState<OutboundNumber[]>([]);
  const [selectedFrom, setSelectedFrom] = useState('');

  const deviceRef = useRef<unknown>(null);
  const connectionRef = useRef<unknown>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ numbers: OutboundNumber[] }>('/admin/outbound-numbers');
        const active = data.numbers.filter((n) => n.active);
        setOutbound(active);
        if (active.length > 0 && !selectedFrom) setSelectedFrom(active[0]!.e164);
      } catch { /* surfaced in Settings */ }
    })();
  }, [selectedFrom]);

  useEffect(() => {
    if (phase !== 'active' || !activeCall) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - activeCall.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase, activeCall]);

  const runFirewall = useCallback(async (overrideNumber?: string) => {
    const target = (overrideNumber ?? raw).trim();
    if (!target) return;
    setBusy(true);
    try {
      const data = await api<FirewallVerdict>('/firewall/precall', {
        method: 'POST',
        body: { toNumber: target, fromNumber: selectedFrom || undefined },
      });
      setFirewall(data);
      setPhase('preflight');
    } catch (e) {
      setToast({ text: `Firewall error: ${(e as Error).message}`, type: 'error' });
    } finally { setBusy(false); }
  }, [raw, selectedFrom, setToast]);

  // Handle a tel: URL: prefill the dialer, snap to idle, run firewall.
  useEffect(() => {
    if (!incomingTel) return;
    setRaw(incomingTel.number);
    setFirewall(null);
    setPhase('idle');
    // Fire-and-forget — the user still has to click the green button to dial.
    void runFirewall(incomingTel.number);
  }, [incomingTel, runFirewall]);

  const place = useCallback(async () => {
    if (!firewall || firewall.decision === 'BLOCK') return;
    setBusy(true);
    try {
      const created = await api<{ call: { id: string; fromNumber: string; toNumber: string; normalizedToNumber: string } }>(
        '/calls',
        {
          method: 'POST',
          body: {
            toNumber: raw,
            auditId: firewall.auditId,
            // Dial exactly the DID the firewall gated (equals the rep's pinned
            // selection when one was chosen). Clicking "Call" on a
            // REQUIRE_REVIEW verdict is the rep's explicit acknowledgement.
            ...(firewall.fromNumber ? { fromNumber: firewall.fromNumber } : selectedFrom ? { fromNumber: selectedFrom } : {}),
            ...(firewall.decision === 'REQUIRE_REVIEW' ? { acknowledged: true } : {}),
          },
        },
      );
      const callId = created.call.id;

      const tok = await api<{ token: string }>('/telephony/token', { method: 'POST' });

      const { Device } = await import('@twilio/voice-sdk');
      const device = new Device(tok.token, { logLevel: 1 });
      deviceRef.current = device;
      await device.register();

      const connection = await device.connect({
        // CallId binds this dial to the firewall-approved call row server-side,
        // so /voice dials only the audited destination + caller ID.
        params: { To: created.call.normalizedToNumber, CallerId: created.call.fromNumber, CallId: callId },
      });
      connectionRef.current = connection;

      setActiveCall({
        callId,
        toNumber: created.call.normalizedToNumber,
        fromNumber: created.call.fromNumber,
        startedAt: Date.now(),
      });
      setPhase('ringing');

      type EmitterCall = { on: (e: string, cb: (...args: unknown[]) => void) => void; parameters?: Record<string, string> };
      const conn = connection as unknown as EmitterCall;

      const persistSid = (): void => {
        const sid = conn.parameters?.CallSid;
        if (sid && callId) void api(`/calls/${callId}`, { method: 'PATCH', body: { providerCallId: sid } });
      };
      conn.on('accept', () => {
        persistSid();
        setPhase('active');
        setActiveCall((s) => (s ? { ...s, startedAt: Date.now() } : s));
        void api(`/calls/${callId}`, { method: 'PATCH', body: { status: 'in_progress', answeredAt: new Date().toISOString() } });
      });
      conn.on('disconnect', () => {
        persistSid();
        setPhase('wrapup');
        void api(`/calls/${callId}`, { method: 'PATCH', body: { status: 'completed', endedAt: new Date().toISOString() } });
        try { (device as unknown as { destroy: () => void }).destroy(); } catch { /* noop */ }
      });
      conn.on('cancel', () => {
        persistSid();
        setPhase('wrapup');
        try { (device as unknown as { destroy: () => void }).destroy(); } catch { /* noop */ }
      });
      conn.on('error', (err) => {
        persistSid();
        const e = err as { message?: string; code?: number };
        setToast({ text: `Call error ${e.code ?? ''}: ${e.message ?? 'unknown'}`, type: 'error' });
      });
    } catch (e) {
      setToast({ text: `Could not place call: ${(e as Error).message}`, type: 'error' });
      setPhase('preflight');
    } finally { setBusy(false); }
  }, [firewall, raw, selectedFrom, setToast]);

  const hangup = useCallback(() => {
    try { (connectionRef.current as { disconnect?: () => void } | null)?.disconnect?.(); }
    catch (err) { setToast({ text: `Hang-up error: ${(err as Error).message}`, type: 'error' }); }
  }, [setToast]);

  const toggleMute = useCallback(() => {
    const c = connectionRef.current as { mute?: (b: boolean) => void } | null;
    const next = !muted;
    c?.mute?.(next);
    setMuted(next);
  }, [muted]);

  const reset = useCallback(() => {
    setRaw('');
    setFirewall(null);
    setPhase('idle');
    setActiveCall(null);
    setElapsed(0);
    setMuted(false);
    setDisposition('Connected');
    setNotes('');
    deviceRef.current = null;
    connectionRef.current = null;
  }, []);

  const submitDisposition = useCallback(async () => {
    if (!activeCall) return;
    setBusy(true);
    try {
      await api(`/calls/${activeCall.callId}/disposition`, {
        method: 'POST',
        body: { disposition, notes, durationSeconds: elapsed },
      });
      setToast({ text: 'Call logged. Salesforce sync queued.', type: 'success' });
      reset();
    } catch (e) {
      setToast({ text: `Could not save: ${(e as Error).message}`, type: 'error' });
    } finally { setBusy(false); }
  }, [activeCall, disposition, notes, elapsed, reset, setToast]);

  // Global keyboard handler: typing digits / + / * / # appends to the dialer.
  // Skips when the user is in a real input/textarea (notes, settings, etc).
  useEffect(() => {
    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };
    const onKey = (e: KeyboardEvent): void => {
      if (phase !== 'idle' && phase !== 'preflight') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (/^[0-9*#+]$/.test(e.key)) {
        e.preventDefault();
        setRaw((v) => v + e.key);
        setFirewall(null);
        setPhase('idle');
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setRaw((v) => v.slice(0, -1));
        setFirewall(null);
        setPhase('idle');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (firewall && firewall.decision !== 'BLOCK') void place();
        else if (raw.trim()) void runFirewall();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, firewall, raw, runFirewall, place, reset]);

  const timer = useMemo(() => {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [elapsed]);

  if (phase === 'ringing' || phase === 'active') {
    return activeCall ? (
      <CallScreen
        phase={phase}
        toNumber={activeCall.toNumber}
        fromNumber={activeCall.fromNumber}
        timer={timer}
        muted={muted}
        onToggleMute={toggleMute}
        onHangup={hangup}
      />
    ) : <></>;
  }

  if (phase === 'wrapup' && activeCall) {
    return (
      <WrapupForm
        toNumber={activeCall.toNumber}
        timer={timer}
        disposition={disposition}
        onDisposition={setDisposition}
        notes={notes}
        onNotes={setNotes}
        busy={busy}
        onSubmit={submitDisposition}
        onDiscard={reset}
      />
    );
  }

  return (
    <div className="dialer">
      <Dialpad
        raw={raw}
        placeholder="Enter a number"
        normalized={firewall?.normalizedTo}
        busy={busy}
        primaryDisabled={busy || !raw.trim() || (!!firewall && firewall.decision === 'BLOCK')}
        primaryTitle={firewall ? (firewall.decision === 'BLOCK' ? 'Blocked' : 'Call now') : 'Check & call'}
        onAppend={(k) => { setRaw((v) => v + k); setFirewall(null); setPhase('idle'); }}
        onBackspace={() => { setRaw((v) => v.slice(0, -1)); setFirewall(null); setPhase('idle'); }}
        onPrimary={firewall && firewall.decision !== 'BLOCK' ? () => void place() : () => void runFirewall()}
      />

      {firewall && (
        <VerdictPanel verdict={firewall} busy={busy} onCancel={reset} onCall={() => void place()} />
      )}

      {outbound.length > 1 && !firewall && (
        <div className="from-picker">
          <label className="lbl">Call from</label>
          <select className="field" value={selectedFrom} onChange={(e) => setSelectedFrom(e.target.value)}>
            {outbound.map((n) => (
              <option key={n.id} value={n.e164}>
                {formatE164(n.e164)}{n.label ? ` · ${n.label}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
