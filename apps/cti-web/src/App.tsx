import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, clearSession, readSession, writeSession } from './api';
import { startRingback, stopRingback } from './ringback';
import { AdminPanel } from './components/AdminPanel';
import { CallLog } from './components/CallLog';
import { DialerPanel } from './components/DialerPanel';
import { IncomingScreen } from './components/IncomingScreen';
import { CallScreen } from './components/CallScreen';
import { Dialpad } from './components/Dialpad';
import { RecentCalls } from './components/RecentCalls';
import { ReputationPanel } from './components/ReputationPanel';
import { VerdictPanel, type FirewallVerdict } from './components/VerdictPanel';
import { WrapupForm } from './components/WrapupForm';
import { startDialer, type DialerObjectType } from './dialer-api';
import { ClockIcon, CloudIcon, GridIcon, PhoneIcon, PhoneOutgoingIcon, SettingsIcon, ShieldIcon, ZapIcon } from './icons';
import { formatE164 } from './format';
import {
  initOpenCti, notifyReady, onClickToDial as onCti, saveCallLog, screenPopRecord, setPanelVisibility,
  type ClickToDialEvent,
} from './opencti';

interface MeResponse {
  user: { userId: string; orgId: string; email: string; isAdmin: boolean };
  salesforce:
    | { connected: false }
    | { connected: true; name?: string | null; email?: string | null; photoDataUrl?: string | null };
}

interface RepSummary {
  avgComposite: number;
  avgGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  flaggedCount: number;
}

type Phase = 'idle' | 'preflight' | 'ringing' | 'active' | 'wrapup';
type Tab = 'dialer' | 'powerdial' | 'recent' | 'reputation' | 'admin' | 'calls';

interface ActiveCall {
  callId: string;
  toNumber: string;
  fromNumber: string;
  startedAt: number;
  /** From Open CTI click — used to attach the Task to the right SF record. */
  recordId?: string;
  recordName?: string;
  objectType?: string;
}

/** A terminal outbound call still awaiting a disposition (from the server). */
interface PendingDisposition {
  id: string;
  toNumber: string;
  fromNumber: string;
  durationSeconds: number;
  status: string;
  notes: string;
  whoId?: string | null;
  whatId?: string | null;
}

/** Sensible default disposition from how the call actually ended, so a reopened
 *  wrap-up isn't mislabeled "Connected" for a call that never connected. */
function defaultDispositionForStatus(status: string): string {
  if (status === 'no_answer' || status === 'canceled') return 'No answer';
  if (status === 'busy') return 'Busy';
  return 'Connected';
}

/** Minimal shape of a Twilio Voice SDK incoming Call. */
interface TwilioIncomingCall {
  parameters?: Record<string, string>;
  accept: () => void;
  reject: () => void;
  disconnect?: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

export function App(): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signedIn, setSignedIn] = useState(!!readSession());
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'error' | 'success' } | null>(null);
  const [ctiReady, setCtiReady] = useState(false);
  // True when the persistent Twilio device's token refresh has exhausted its
  // retries — inbound callbacks will stop arriving, so surface it in the header.
  const [inboundDegraded, setInboundDegraded] = useState(false);
  const [tab, setTab] = useState<Tab>('dialer');
  const [rep, setRep] = useState<RepSummary | null>(null);

  const [raw, setRaw] = useState('');
  const [firewall, setFirewall] = useState<FirewallVerdict | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [muted, setMuted] = useState(false);
  const [disposition, setDisposition] = useState('Connected');
  const [notes, setNotes] = useState('');
  const [ctiContext, setCtiContext] = useState<ClickToDialEvent | null>(null);
  // A ringing INBOUND call waiting for the rep to accept/decline in the CTI.
  const [incoming, setIncoming] = useState<TwilioIncomingCall | null>(null);
  // The rep's outstanding un-dispositioned call (server truth), if any — drives
  // the persistent "finish your last call" banner so returning is discoverable.
  const [pendingDisp, setPendingDisp] = useState<PendingDisposition | null>(null);

  // Power dialer: the active session id (server truth for the run), owned here
  // so it survives switching away from and back to the Power Dial tab. This is
  // intentionally NOT part of `phase`/`active` — the conference leg the rep sits
  // on spans many prospect calls, so it must never hide the nav (see `inCall`).
  const [dialerSessionId, setDialerSessionId] = useState<string | null>(null);

  // Display name — persists in localStorage on this origin. Used only as a
  // fallback when SF OAuth isn't wired; the SF profile is preferred.
  const [customDisplayName, setCustomDisplayName] = useState<string | null>(() => {
    try { return localStorage.getItem('cti.displayName')?.trim() || null; } catch { return null; }
  });
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const saveName = useCallback(() => {
    const next = nameDraft.trim();
    setCustomDisplayName(next || null);
    try {
      if (next) localStorage.setItem('cti.displayName', next);
      else localStorage.removeItem('cti.displayName');
    } catch { /* ignore */ }
    setEditingName(false);
  }, [nameDraft]);

  // ---- Sign in with Salesforce (OAuth popup) -------------------------------
  const [sfConnecting, setSfConnecting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const refreshMe = useCallback(async () => {
    try { setMe(await api<MeResponse>('/auth/me')); } catch { /* */ }
  }, []);

  // Primary production login: no pre-existing session. Opens the SF OAuth
  // popup, then polls login-status until it hands back a session token.
  const loginWithSalesforce = useCallback(async () => {
    setSigningIn(true);
    try {
      const { authUrl, handshake } = await api<{ authUrl: string; handshake: string }>(
        '/auth/salesforce/login/start', { method: 'POST', authed: false },
      );
      const popup = window.open(authUrl, 'cti-sf-login', 'width=600,height=720,noopener,noreferrer');
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 5 * 60 * 1000) {
          setSigningIn(false);
          setToast({ text: 'Salesforce sign-in timed out.', type: 'error' });
          return;
        }
        try {
          const r = await api<{ status: string; token?: string; user?: { id: string; email: string } }>(
            `/auth/salesforce/login/status?handshake=${encodeURIComponent(handshake)}`, { authed: false },
          );
          if (r.status === 'connected' && r.token && r.user) {
            try { popup?.close(); } catch { /* */ }
            writeSession({ token: r.token, userId: r.user.id, email: r.user.email });
            setSignedIn(true);
            await refreshMe();
            setSigningIn(false);
            setToast({ text: 'Signed in with Salesforce.', type: 'success' });
            return;
          }
          if (r.status === 'failed') {
            setSigningIn(false);
            setToast({ text: 'Salesforce sign-in failed or org not authorized.', type: 'error' });
            return;
          }
        } catch { /* status momentarily unreachable — keep polling */ }
        setTimeout(poll, 1500);
      };
      void poll();
    } catch (e) {
      setSigningIn(false);
      setToast({ text: (e as Error).message, type: 'error' });
    }
  }, [refreshMe]);
  const connectSalesforce = useCallback(async () => {
    setSfConnecting(true);
    try {
      const { authUrl, handshake } = await api<{ authUrl: string; handshake: string }>(
        '/auth/salesforce/start', { method: 'POST' },
      );
      // Popup — Salesforce login pages set X-Frame-Options DENY so we can't
      // iframe them. noopener + noreferrer so a compromised OAuth page can't
      // navigate us.
      const popup = window.open(authUrl, 'cti-sf-oauth', 'width=600,height=720,noopener,noreferrer');
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 5 * 60 * 1000) {
          setSfConnecting(false);
          setToast({ text: 'Salesforce sign-in timed out.', type: 'error' });
          return;
        }
        try {
          const { status } = await api<{ status: string }>(
            `/auth/salesforce/status?handshake=${encodeURIComponent(handshake)}`,
          );
          if (status === 'connected') {
            try { popup?.close(); } catch { /* */ }
            await refreshMe();
            setSfConnecting(false);
            setToast({ text: 'Signed in with Salesforce.', type: 'success' });
            return;
          }
          if (status === 'failed') {
            setSfConnecting(false);
            setToast({ text: 'Salesforce sign-in failed.', type: 'error' });
            return;
          }
        } catch {
          // status endpoint may be momentarily unreachable — keep polling
        }
        setTimeout(poll, 1500);
      };
      void poll();
    } catch (e) {
      setSfConnecting(false);
      setToast({ text: (e as Error).message, type: 'error' });
    }
  }, [refreshMe]);

  const deviceRef = useRef<unknown>(null);
  const connectionRef = useRef<unknown>(null);
  // The rep's power-dialer conference leg — kept in its OWN ref, separate from
  // connectionRef, so joining/leaving it never touches phase/active/inCall and
  // never collides with a normal click-to-dial or inbound call's connection.
  const dialerConnRef = useRef<unknown>(null);
  // Generation counter for power-dialer runs: incremented at the start of each
  // startPowerDial() and in handleDialerStop(). Used to guard against the race
  // where an in-flight connect() resolves AFTER a stop/new-start, preventing a
  // stale connection from overwriting the cleared ref and leaking a conference leg.
  const dialerRunRef = useRef(0);
  // True from the first line of place() until it settles — used to reject an
  // inbound call that races an in-flight outbound dial (which would otherwise
  // clobber connectionRef and orphan the outbound leg).
  const placingRef = useRef(false);
  // In-flight device creation, so concurrent ensureDevice() callers (mount
  // effect + place()) share ONE Device instead of each building their own.
  const deviceInitRef = useRef<Promise<unknown> | null>(null);
  // Latest phase, readable from long-lived Twilio event closures (which capture
  // a stale `phase` at registration time).
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  // Latest ringing inbound call, readable synchronously from place().
  const incomingRef = useRef<TwilioIncomingCall | null>(null);
  useEffect(() => { incomingRef.current = incoming; }, [incoming]);

  // Destroy + forget the persistent Twilio device. Idempotent. Stops it ringing
  // and, crucially, stops its tokenWillExpire loop from POSTing /telephony/token.
  const teardownDevice = useCallback(() => {
    const d = deviceRef.current as { destroy?: () => void } | null;
    deviceRef.current = null;
    deviceInitRef.current = null;
    if (d) { try { d.destroy?.(); } catch { /* already gone */ } }
  }, []);

  // Clear the local session and return to the sign-in gate. Tears down the
  // device first so a dead session can't leave it registered (ringing with no UI
  // to answer) or looping on token refresh.
  const signOut = useCallback(() => {
    teardownDevice();
    clearSession();
    setMe(null);
    setSignedIn(false);
    setInboundDegraded(false);
    // Never carry one rep's pending-disposition banner into the next sign-in on
    // a shared browser (reopening it would PATCH a call they don't own).
    setPendingDisp(null);
  }, [teardownDevice]);

  // Destroy the device on unmount (empty deps → runs only on real unmount, not
  // on every `me` change, which would churn the device).
  useEffect(() => () => teardownDevice(), [teardownDevice]);

  // Auto-dismiss the status/error banner after a few seconds so it doesn't sit
  // in the way at the bottom of the dialer.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Play a local ringback tone while an OUTBOUND call is ringing (Twilio's
  // carrier ringback doesn't reliably reach the browser).
  useEffect(() => {
    if (phase === 'ringing') startRingback();
    else stopRingback();
    return () => stopRingback();
  }, [phase]);
  // Set once the Open CTI Task has been written for the current call, so a
  // disposition retry doesn't create a duplicate Task.
  const openCtiTaskWrittenRef = useRef(false);

  // ---- bootstrap: sign in to backend (dev session for MVP), then init Open CTI
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let s = readSession();
        if (!s && import.meta.env.DEV) {
          // Dev convenience only — /auth/dev-session is 404 in production.
          const r = await api<{ token: string; user: { id: string; email: string } }>(
            '/auth/dev-session', { method: 'POST', authed: false },
          );
          s = { token: r.token, userId: r.user.id, email: r.user.email };
          writeSession(s);
        }
        if (cancelled) return;
        if (!s) {
          // No session → render the "Sign in with Salesforce" gate.
          setSignedIn(false);
        } else {
          setSignedIn(true);
          const m = await api<MeResponse>('/auth/me');
          if (cancelled) return;
          setMe(m);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          signOut();
        } else {
          setToast({ text: `Sign-in failed: ${(e as Error).message}`, type: 'error' });
        }
      }

      // Init Open CTI — only does anything when running inside Salesforce.
      try {
        const r = await initOpenCti();
        if (cancelled) return;
        if (r.ready) {
          setCtiReady(true);
          onCti((evt) => {
            // Click-to-dial: surface the panel, prefill, auto-run the firewall,
            // and remember the record context (used by saveLog + timezone).
            setPanelVisibility(true);
            setTab('dialer');
            setRaw(evt.number);
            setCtiContext(evt);
            setFirewall(null);
            setPhase('idle');
            void runFirewallNow(evt.number, evt.recordId);
          });
          notifyReady();
        } else if (r.reason) {
          // Standalone preview — fine, just no click-to-dial.
          console.info('Open CTI not initialized:', r.reason);
        }
      } catch (e) {
        console.warn('Open CTI init failed', e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Header reputation chip — refreshed every minute, never blocks anything.
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await api<{ summary: RepSummary }>('/reputation');
        if (alive) setRep(r.summary);
      } catch { /* chip is best-effort */ }
    };
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [signedIn]);

  // Call timer
  useEffect(() => {
    if (phase !== 'active' || !active) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - active.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase, active]);

  // Run-firewall variant that takes the number directly (state closures won't
  // have updated yet when called right after setRaw).
  const runFirewallNow = useCallback(async (target: string, recordId?: string) => {
    if (!target.trim()) return;
    setBusy(true);
    try {
      const data = await api<FirewallVerdict>('/firewall/precall', {
        method: 'POST',
        body: {
          toNumber: target,
          ...(recordId ? { recipientRecordId: recordId } : {}),
        },
      });
      setFirewall(data);
      setPhase('preflight');
    } catch (e) {
      setToast({ text: `Firewall error: ${(e as Error).message}`, type: 'error' });
    } finally { setBusy(false); }
  }, []);

  const runFirewall = useCallback(
    () => runFirewallNow(raw, ctiContext?.recordId),
    [runFirewallNow, raw, ctiContext?.recordId],
  );

  // Lazily create + register ONE persistent Twilio device, reused for both
  // outbound dials and INBOUND calls (so callbacks ring the softphone). Idempotent.
  const ensureDevice = useCallback(async (): Promise<unknown> => {
    if (deviceRef.current) return deviceRef.current;
    if (deviceInitRef.current) return deviceInitRef.current;
    const init = (async () => {
    const tok = await api<{ token: string }>('/telephony/token', { method: 'POST' });
    const { Device } = await import('@twilio/voice-sdk');
    const device = new Device(tok.token, { logLevel: 1 });
    deviceRef.current = device;
    const d = device as unknown as {
      on: (e: string, cb: (a: unknown) => void) => void;
      register: () => Promise<void>;
      updateToken: (t: string) => void;
    };
    // Device-level errors (e.g. AccessTokenInvalid) → toast; never wipe a live call.
    d.on('error', (err) => {
      const e = err as { message?: string; code?: number } | undefined;
      setToast({ text: `Call error ${e?.code ?? ''}: ${e?.message ?? 'Twilio device error'}`.replace('  ', ' ').trim(), type: 'error' });
      if (phaseRef.current !== 'active' && phaseRef.current !== 'wrapup') setPhase('preflight');
      setBusy(false);
    });
    // Refresh the token before expiry so the device stays registered for
    // incoming. A single dropped refresh would let the 1h token lapse → the
    // device unregisters → the rep silently stops receiving callbacks for the
    // rest of the shift. Retry with backoff; a 401 means the session is dead
    // (sign out, which also destroys this device and stops the loop); if every
    // retry fails, surface it so degraded inbound is noticeable.
    d.on('tokenWillExpire', () => {
      void (async () => {
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            const t = await api<{ token: string }>('/telephony/token', { method: 'POST' });
            d.updateToken(t.token);
            setInboundDegraded(false);
            return;
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) { signOut(); return; }
            // Backoff 1s, 2s, 4s, 8s between attempts (none after the last).
            if (attempt < maxAttempts - 1) {
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
        }
        setInboundDegraded(true);
        setToast({ text: 'Inbound calls may be unavailable — could not refresh Twilio token. Please reload.', type: 'error' });
      })();
    });
    // An INBOUND callback dialed to this rep's client identity.
    d.on('incoming', (callObj) => {
      const call = callObj as TwilioIncomingCall;
      // Decline (→ voicemail) if the rep is busy OR an outbound dial is in
      // flight — no call-waiting, and never race an in-progress place().
      if (placingRef.current || (phaseRef.current !== 'idle' && phaseRef.current !== 'preflight')) {
        try { call.reject(); } catch { /* */ }
        return;
      }
      // Clear the ringing UI if the caller hangs up or the leg is cancelled
      // (e.g. answered in another tab) before the rep picks up.
      call.on('cancel', () => setIncoming((c) => (c === call ? null : c)));
      call.on('disconnect', () => setIncoming((c) => (c === call ? null : c)));
      setIncoming(call);
      // Pop the softphone panel open (Salesforce utility bar) so the rep sees the
      // ring without hunting for the tab — as long as they're in Salesforce.
      try { setPanelVisibility(true); } catch { /* not embedded in SF */ }
    });
    // Reflect REAL registration state: a device that silently drops its
    // registration means inbound callbacks stop arriving, so surface it. Guard on
    // identity so an ORPHANED device (from a failed init/retry) can't flip the
    // status of the current, healthy one.
    d.on('registered', () => { if (deviceRef.current === device) setInboundDegraded(false); });
    d.on('unregistered', () => { if (deviceRef.current === device) setInboundDegraded(true); });
    await d.register();
    return device;
    })();
    deviceInitRef.current = init;
    try {
      return await init;
    } catch (err) {
      // Failed init — destroy the half-built device so it stops emitting
      // registered/unregistered events, then clear so the next call retries clean.
      try { (deviceRef.current as { destroy?: () => void } | null)?.destroy?.(); } catch { /* */ }
      deviceInitRef.current = null;
      deviceRef.current = null;
      throw err;
    }
  }, [signOut]);

  // Disconnect the rep's power-dialer conference leg (if any) and clear the
  // session. Idempotent — safe to call twice (e.g. Stop button + DialerPanel
  // unmount), since a second call just finds a null ref and a null sessionId.
  const handleDialerStop = useCallback(() => {
    dialerRunRef.current++; // Invalidate any in-flight startPowerDial()
    const conn = dialerConnRef.current as { disconnect?: () => void } | null;
    dialerConnRef.current = null;
    if (conn) { try { conn.disconnect?.(); } catch { /* already gone */ } }
    setDialerSessionId(null);
  }, []);

  // Start a server-originated power-dialer run: validate the payload, create
  // the session, switch to the Power Dial tab, then join the rep's softphone to
  // the run's Twilio conference (mirrors place()'s device.connect() shape, but
  // with DialerConference instead of To/CallerId/CallId — the server's /voice
  // DialerConference branch puts this leg in the conference room instead of
  // dialing a destination). Deliberately does NOT touch phase/active/inCall:
  // this leg is long-lived across many prospect calls, not a single call.
  const startPowerDial = useCallback(async (objectType: unknown, recordIds: unknown): Promise<void> => {
    if (objectType !== 'Lead' && objectType !== 'Opportunity') {
      setToast({ text: 'Power Dial: invalid or missing object type.', type: 'error' });
      return;
    }
    if (!Array.isArray(recordIds) || recordIds.length === 0 || !recordIds.every((id) => typeof id === 'string' && id.trim())) {
      setToast({ text: 'Power Dial: select at least one record.', type: 'error' });
      return;
    }
    // Capture the run generation BEFORE any await, so an in-flight start
    // can detect if a stop or new start has superseded it.
    const myRun = ++dialerRunRef.current;
    try {
      const { sessionId } = await startDialer(objectType as DialerObjectType, recordIds as string[]);
      setDialerSessionId(sessionId);
      setTab('powerdial');
      const device = await ensureDevice();
      const connection = await (device as unknown as { connect: (o: unknown) => Promise<unknown> }).connect({
        params: { DialerConference: '1' },
      });
      // Guard: if a stop or new start happened while we were awaiting, this run
      // is superseded. Disconnect the stale leg and return — don't leak it.
      if (dialerRunRef.current !== myRun) {
        try { (connection as { disconnect?: () => void }).disconnect?.(); } catch { /* already gone */ }
        return;
      }
      dialerConnRef.current = connection;
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
      setToast({ text: `Could not start power dial: ${msg}`, type: 'error' });
    }
  }, [ensureDevice]);

  // Record intake (handoff seam): the Salesforce LWC (or a test harness) hands
  // us a run via postMessage rather than a direct function call, since it lives
  // in a different frame. Minimal origin sanity — only accept messages from the
  // frame that's embedding us (or, standalone/dev, the window itself, since
  // window.parent === window there) — and otherwise ignore silently; a stray or
  // malformed message from an unrelated script must never throw.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) return;
      const data = event.data as unknown;
      if (!data || typeof data !== 'object') return;
      const { type, objectType, recordIds } = data as Record<string, unknown>;
      if (type !== 'POWER_DIAL') return;
      void startPowerDial(objectType, recordIds);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [startPowerDial]);

  // Reopen a still-un-dispositioned call's wrap-up, rehydrated from the server so
  // it isn't blank or mislabeled. No recordId is set: the backend already holds
  // the click-to-dial record (persisted at dial time), so the disposition
  // attaches correctly without writing a second Open-CTI Task.
  const reopenDisposition = useCallback((p: PendingDisposition) => {
    openCtiTaskWrittenRef.current = false;
    connectionRef.current = null;
    setActive({ callId: p.id, toNumber: p.toNumber, fromNumber: p.fromNumber, startedAt: Date.now() });
    setElapsed(p.durationSeconds ?? 0);
    setDisposition(defaultDispositionForStatus(p.status));
    setNotes(p.notes ?? '');
    setMuted(false);
    setPhase('wrapup');
    setPendingDisp(p);
  }, []);

  // Server truth for "do I still owe a disposition?" — drives the banner.
  const refreshPending = useCallback(async () => {
    try {
      const r = await api<{ pending: PendingDisposition | null }>('/calls/pending-disposition');
      setPendingDisp(r.pending);
    } catch { /* best-effort */ }
  }, []);

  // Once signed in: register the device (so callbacks ring the softphone) and
  // check for an unfinished disposition. A registration failure is surfaced —
  // otherwise inbound would silently never arrive and the rep wouldn't know.
  useEffect(() => {
    if (!me) return;
    void ensureDevice().catch(() => {
      setInboundDegraded(true);
      setToast({ text: 'Inbound calls unavailable — reload to receive callbacks.', type: 'error' });
    });
    void refreshPending();
  }, [me, ensureDevice, refreshPending]);

  const place = useCallback(async () => {
    if (!firewall || firewall.decision === 'BLOCK') return;
    // Claim the outbound path synchronously so a callback that rings during the
    // POST /calls + device.connect() awaits is declined (→ voicemail) instead of
    // racing this dial. Also drop any ringing inbound: the rep chose to dial out.
    placingRef.current = true;
    if (incomingRef.current) {
      try { incomingRef.current.reject(); } catch { /* */ }
      setIncoming(null);
    }
    setBusy(true);
    try {
      let created: { call: { id: string; fromNumber: string; toNumber: string; normalizedToNumber: string } };
      try {
        created = await api<{ call: { id: string; fromNumber: string; toNumber: string; normalizedToNumber: string } }>(
          '/calls', {
            method: 'POST',
            body: {
              toNumber: raw,
              auditId: firewall.auditId,
              // Dial exactly the DID the firewall gated. Clicking "Call" on a
              // REQUIRE_REVIEW verdict is the rep's explicit acknowledgement.
              ...(firewall.fromNumber ? { fromNumber: firewall.fromNumber } : {}),
              ...(firewall.decision === 'REQUIRE_REVIEW' ? { acknowledged: true } : {}),
              // Persist the click-to-dial record now so a reopened disposition
              // still attaches to the exact Lead/Contact/Opportunity/Deal__c.
              ...(ctiContext?.recordId
                ? { recipientRecordId: ctiContext.recordId, recipientObjectType: ctiContext.objectType }
                : {}),
            },
          },
        );
      } catch (e) {
        // The server blocks a new dial until the previous call is dispositioned.
        // Reopen that call's wrap-up (rehydrated) so the rep can log it, then dial.
        if (e instanceof ApiError && e.status === 409 && (e.data as { code?: string })?.code === 'DISPOSITION_REQUIRED') {
          const pc = (e.data as { pendingCall?: PendingDisposition }).pendingCall;
          if (pc) reopenDisposition(pc);
          setToast({ text: 'Log your previous call before making another.', type: 'error' });
          setBusy(false);
          return;
        }
        throw e;
      }
      const callId = created.call.id;
      const device = await ensureDevice();
      const connection = await (device as unknown as { connect: (o: unknown) => Promise<unknown> }).connect({
        // CallId binds this dial to the firewall-approved call row server-side,
        // so /voice dials only the audited destination + caller ID.
        params: { To: created.call.normalizedToNumber, CallerId: created.call.fromNumber, CallId: callId },
      });
      connectionRef.current = connection;
      setActive({
        callId,
        toNumber: created.call.normalizedToNumber,
        fromNumber: created.call.fromNumber,
        startedAt: Date.now(),
        recordId: ctiContext?.recordId,
        recordName: ctiContext?.recordName,
        objectType: ctiContext?.objectType,
      });
      setPhase('ringing');

      type EmitterCall = { on: (e: string, cb: (...a: unknown[]) => void) => void; parameters?: Record<string, string> };
      const conn = connection as unknown as EmitterCall;
      const persistSid = (): void => {
        const sid = conn.parameters?.CallSid;
        if (sid) void api(`/calls/${callId}`, { method: 'PATCH', body: { providerCallId: sid } });
      };
      conn.on('accept', () => {
        persistSid();
        setPhase('active');
        setActive((s) => (s ? { ...s, startedAt: Date.now() } : s));
        void api(`/calls/${callId}`, { method: 'PATCH', body: { status: 'in_progress', answeredAt: new Date().toISOString() } });
      });
      conn.on('disconnect', () => {
        persistSid();
        setPhase('wrapup');
        void api(`/calls/${callId}`, { method: 'PATCH', body: { status: 'completed', endedAt: new Date().toISOString() } });
        // Keep the device registered (persistent) so it can place the next call
        // and receive inbound callbacks.
      });
      conn.on('cancel', () => {
        persistSid(); setPhase('wrapup');
      });
      conn.on('error', (err) => {
        persistSid();
        const e = err as { message?: string; code?: number };
        setToast({ text: `Call error ${e.code ?? ''}: ${e.message ?? 'unknown'}`, type: 'error' });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';
      setToast({ text: `Could not place call: ${msg}`, type: 'error' });
      setPhase('preflight');
    } finally { setBusy(false); placingRef.current = false; }
  }, [firewall, raw, ctiContext, ensureDevice, reopenDisposition]);

  const hangup = useCallback(() => {
    try { (connectionRef.current as { disconnect?: () => void } | null)?.disconnect?.(); } catch { /* */ }
  }, []);
  const toggleMute = useCallback(() => {
    const c = connectionRef.current as { mute?: (b: boolean) => void } | null;
    const next = !muted; c?.mute?.(next); setMuted(next);
  }, [muted]);

  const reset = useCallback(() => {
    setRaw(''); setFirewall(null); setPhase('idle'); setActive(null);
    setElapsed(0); setMuted(false); setDisposition('Connected'); setNotes('');
    setCtiContext(null);
    // Keep the persistent device registered (for the next call + inbound); only
    // clear the per-call connection.
    connectionRef.current = null;
    placingRef.current = false;
    openCtiTaskWrittenRef.current = false;
  }, []);

  // Answer an inbound callback in the CTI. Inbound calls auto-log server-side,
  // so there's no wrap-up form — on hangup we just return to idle.
  const acceptIncoming = useCallback(() => {
    const call = incoming;
    // Don't answer if an outbound dial just claimed the line.
    if (!call || placingRef.current) return;
    const from = call.parameters?.From ?? call.parameters?.from ?? '';
    const backToIdle = (): void => {
      setPhase('idle'); setActive(null); setElapsed(0); setIncoming(null);
      connectionRef.current = null;
    };
    connectionRef.current = call;
    setActive({ callId: '', toNumber: from, fromNumber: from, startedAt: Date.now(), recordName: 'Incoming call' });
    setIncoming(null);
    setMuted(false);
    setPhase('active');
    try { call.accept(); } catch { backToIdle(); return; }
    call.on('disconnect', backToIdle);
    // A media/mic failure after accept may never emit 'disconnect'; recover the
    // UI (inbound has no wrap-up form) instead of stranding an 'active' screen.
    call.on('error', (err) => {
      const e = err as { message?: string; code?: number } | undefined;
      setToast({ text: `Call error ${e?.code ?? ''}: ${e?.message ?? 'unknown'}`, type: 'error' });
      backToIdle();
    });
  }, [incoming]);

  const declineIncoming = useCallback(() => {
    try { incoming?.reject(); } catch { /* */ }
    setIncoming(null);
  }, [incoming]);

  const submitDisposition = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      // If we know the click-to-dial record, write the Task via Open CTI FIRST
      // (attaches to the exact record in the SF UI). Only when that succeeds do
      // we tell the backend to skip — otherwise the backend creates and attaches
      // the Task itself from the record we hand it, so a logged call is never lost.
      const isWho = active.objectType === 'Lead' || active.objectType === 'Contact';
      // If a prior submit attempt already wrote the Task via Open CTI, don't
      // write it again on retry — just re-attempt the backend disposition PATCH.
      let loggedViaOpenCti = openCtiTaskWrittenRef.current;
      if (active.recordId && !openCtiTaskWrittenRef.current) {
        loggedViaOpenCti = await saveCallLog({
          Subject: `Outbound Call - ${active.toNumber}`,
          Status: 'Completed',
          TaskSubtype: 'Call',
          CallType: 'Outbound',
          CallDisposition: disposition,
          CallDurationInSeconds: elapsed,
          Description: notes || '',
          WhoId: isWho ? active.recordId : undefined,
          WhatId: isWho ? undefined : active.recordId,
        });
        if (loggedViaOpenCti) openCtiTaskWrittenRef.current = true;
      }
      await api(`/calls/${active.callId}/disposition`, {
        method: 'POST',
        body: {
          disposition,
          notes,
          durationSeconds: elapsed,
          skipSalesforceSync: loggedViaOpenCti,
          // Hand the backend the exact record when Open CTI didn't log it, so it
          // attaches the Task to the right Lead/Contact/Opportunity/Deal__c.
          ...(active.recordId && !loggedViaOpenCti
            ? { recipientRecordId: active.recordId, recipientObjectType: active.objectType }
            : {}),
        },
      });
      setToast({
        text: active.recordId
          ? `Call logged · attached to ${active.recordName ?? active.objectType ?? 'record'}`
          : 'Call logged. Salesforce sync queued.',
        type: 'success',
      });
      // Clear the banner SYNCHRONOUSLY so it can't re-show (and re-open) the call
      // that was just logged; refreshPending() then reconciles best-effort.
      setPendingDisp(null);
      reset();
      void refreshPending();
    } catch (e) {
      setToast({ text: `Could not save: ${(e as Error).message}`, type: 'error' });
    } finally { setBusy(false); }
  }, [active, disposition, notes, elapsed, reset, refreshPending]);

  // Global keyboard input for the dialpad (only while it's visible)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (tab !== 'dialer') return;
      if (phase !== 'idle' && phase !== 'preflight') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9*#+]$/.test(e.key)) { e.preventDefault(); setRaw((v) => v + e.key); setFirewall(null); setPhase('idle'); setCtiContext(null); }
      else if (e.key === 'Backspace') { e.preventDefault(); setRaw((v) => v.slice(0, -1)); setFirewall(null); setPhase('idle'); setCtiContext(null); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (firewall && firewall.decision !== 'BLOCK') void place();
        else if (raw.trim()) void runFirewall();
      } else if (e.key === 'Escape') { e.preventDefault(); reset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, phase, firewall, raw, runFirewall, place, reset]);

  const timer = useMemo(() => {
    const m = Math.floor(elapsed / 60); const s = elapsed % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, [elapsed]);

  if (!signedIn || !me) {
    return (
      <div className="app">
        <div className="signin">
          <div className="logo"><PhoneIcon /></div>
          <h2>Caller Reputation CTI</h2>
          {signingIn ? (
            <><p>Signing in with Salesforce…</p><span className="spinner lg" /></>
          ) : signedIn ? (
            <><p>Loading…</p><span className="spinner lg" /></>
          ) : (
            <>
              <p>Sign in with your Salesforce account to start calling.</p>
              <button className="btn primary full" onClick={() => void loginWithSalesforce()}>
                Sign in with Salesforce
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const sf = me.salesforce.connected ? me.salesforce : null;
  const isDevSession = me.user.email === 'dev@example.com';
  const sessionPrefix = !isDevSession ? me.user.email?.split('@')[0] : null;
  const displayName = sf?.name?.trim() || customDisplayName || sessionPrefix || 'Sales Rep';
  const initials = displayName.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'DR';
  const photo = sf?.photoDataUrl ?? null;
  const nameIsEditable = !sf; // SF owns the identity when connected
  const inCall = phase === 'ringing' || phase === 'active' || phase === 'wrapup';

  const header = (
    <div className="header">
      <div className="left">
        {photo
          ? <img src={photo} alt={displayName} className="avatar photo" />
          : <div className="avatar">{initials}</div>}
        <div className="identity">
          {editingName && nameIsEditable ? (
            <input
              autoFocus
              className="field name-edit"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
                else if (e.key === 'Escape') { setEditingName(false); setNameDraft(''); }
              }}
              placeholder="Your name"
              maxLength={64}
            />
          ) : (
            <div
              className={`name ${nameIsEditable ? 'editable' : ''}`}
              role={nameIsEditable ? 'button' : undefined}
              title={nameIsEditable ? 'Click to edit your name' : undefined}
              onClick={nameIsEditable
                ? () => { setNameDraft(customDisplayName ?? (displayName === 'Sales Rep' ? '' : displayName)); setEditingName(true); }
                : undefined}
            >
              {displayName}
            </div>
          )}
          <div className="status">
            <span className={`presence-dot ${inboundDegraded ? 'bad' : ctiReady ? '' : 'warn'}`} />
            {inboundDegraded
              ? 'Inbound unavailable — reload'
              : ctiReady ? 'Salesforce CTI connected' : 'Standalone'}
          </div>
        </div>
      </div>
      <div className="right">
        {rep && (
          <button
            className={`rep-chip grade-${rep.avgGrade.toLowerCase()} ${rep.flaggedCount > 0 ? 'flagged' : ''}`}
            title={`Caller reputation ${rep.avgComposite}/100${rep.flaggedCount > 0 ? ` · ${rep.flaggedCount} flagged` : ''}`}
            onClick={() => { if (!inCall) setTab('reputation'); }}
          >
            <ShieldIcon />
            <span>{rep.avgGrade}</span>
          </button>
        )}
        {sf && (
          <div className="iconbtn linked" title="Salesforce linked">
            <CloudIcon />
          </div>
        )}
      </div>
    </div>
  );

  // CTA shown when SF isn't connected. One click opens a popup, polls until
  // the OAuth handshake completes, then refreshes /auth/me.
  const sfBanner = !sf ? (
    <div className="sf-banner">
      <CloudIcon />
      <div className="sf-banner-text">Connect Salesforce to log calls automatically.</div>
      <button className="btn primary compact" disabled={sfConnecting} onClick={connectSalesforce}>
        {sfConnecting ? <><span className="spinner" /> Waiting…</> : 'Connect'}
      </button>
    </div>
  ) : null;

  // Persistent, discoverable way back to an un-finished disposition — so a rep
  // who navigated away (or reloaded) isn't stuck until the next dial 409s.
  const dispositionBanner = !inCall && pendingDisp ? (
    <button className="disp-banner" onClick={() => reopenDisposition(pendingDisp)}>
      <span className="disp-dot" />
      <span className="disp-text">Finish your last call — {formatE164(pendingDisp.toNumber)} needs a disposition</span>
      <span className="disp-cta">Finish →</span>
    </button>
  ) : null;

  const body = incoming && !inCall ? (
    <IncomingScreen
      from={incoming.parameters?.From ?? incoming.parameters?.from}
      onAccept={acceptIncoming}
      onDecline={declineIncoming}
    />
  ) : inCall && active ? (
    phase === 'wrapup' ? (
      <WrapupForm
        toNumber={active.toNumber}
        fromNumber={active.fromNumber}
        timer={timer}
        recordName={active.recordName}
        disposition={disposition}
        onDisposition={setDisposition}
        notes={notes}
        onNotes={setNotes}
        busy={busy}
        onSubmit={submitDisposition}
      />
    ) : (
      <CallScreen
        phase={phase === 'ringing' ? 'ringing' : 'active'}
        toNumber={active.toNumber}
        fromNumber={active.fromNumber}
        recordName={active.recordName}
        objectType={active.objectType}
        timer={timer}
        muted={muted}
        onToggleMute={toggleMute}
        onHangup={hangup}
      />
    )
  ) : tab === 'recent' ? (
    <RecentCalls
      onReopen={(c) => reopenDisposition({
        id: c.id,
        toNumber: c.normalizedToNumber,
        fromNumber: c.fromNumber,
        durationSeconds: c.durationSeconds ?? 0,
        status: c.status,
        notes: c.notes ?? '',
        whoId: c.salesforceWhoId,
        whatId: c.salesforceWhatId,
      })}
    />
  ) : tab === 'reputation' ? (
    <ReputationPanel />
  ) : tab === 'admin' ? (
    <AdminPanel />
  ) : tab === 'calls' ? (
    <CallLog />
  ) : tab === 'powerdial' ? (
    <DialerPanel
      sessionId={dialerSessionId}
      onScreenPop={screenPopRecord}
      onStart={() => { /* App already owns session start (see startPowerDial) */ }}
      onStop={handleDialerStop}
    />
  ) : (
    <div className="dialer">
      <Dialpad
        raw={raw}
        placeholder={ctiReady ? 'Click a phone in Salesforce, or type' : 'Type a number'}
        normalized={firewall?.normalizedTo}
        busy={busy}
        primaryDisabled={busy || !raw.trim() || (!!firewall && firewall.decision === 'BLOCK')}
        primaryTitle={firewall ? (firewall.decision === 'BLOCK' ? 'Blocked' : 'Call now') : 'Check & call'}
        onAppend={(k) => { setRaw((v) => v + k); setFirewall(null); setPhase('idle'); setCtiContext(null); }}
        onBackspace={() => { setRaw((v) => v.slice(0, -1)); setFirewall(null); setPhase('idle'); setCtiContext(null); }}
        onPrimary={firewall && firewall.decision !== 'BLOCK' ? () => void place() : () => void runFirewall()}
      />
      {firewall && (
        <VerdictPanel verdict={firewall} busy={busy} onCancel={reset} onCall={() => void place()} />
      )}
    </div>
  );

  const navItems: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'dialer', label: 'Dial', icon: <GridIcon /> },
    // Every signed-in rep can run a power-dialer session — not admin-gated.
    { id: 'powerdial', label: 'Power Dial', icon: <ZapIcon /> },
    { id: 'recent', label: 'Recent', icon: <ClockIcon /> },
    { id: 'reputation', label: 'Reputation', icon: <ShieldIcon /> },
    // Number-pool management + org call log — admins only (server 403s regardless).
    ...(me.user.isAdmin
      ? [
          { id: 'admin' as Tab, label: 'Numbers', icon: <SettingsIcon /> },
          { id: 'calls' as Tab, label: 'Calls', icon: <PhoneOutgoingIcon /> },
        ]
      : []),
  ];

  return (
    <div className="app">
      {header}
      {sfBanner}
      {dispositionBanner}
      <div className="body">{body}</div>
      {!inCall && (
        <div className="nav">
          {navItems.map((i) => (
            <button key={i.id} className={`tab ${tab === i.id ? 'active' : ''}`} onClick={() => setTab(i.id)}>
              {i.icon}
              <span>{i.label}</span>
            </button>
          ))}
        </div>
      )}
      {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
