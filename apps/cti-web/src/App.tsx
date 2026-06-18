import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, clearSession, readSession, writeSession } from './api';
import { AdminPanel } from './components/AdminPanel';
import { CallScreen } from './components/CallScreen';
import { Dialpad } from './components/Dialpad';
import { RecentCalls } from './components/RecentCalls';
import { ReputationPanel } from './components/ReputationPanel';
import { VerdictPanel, type FirewallVerdict } from './components/VerdictPanel';
import { WrapupForm } from './components/WrapupForm';
import { ClockIcon, CloudIcon, GridIcon, PhoneIcon, SettingsIcon, ShieldIcon } from './icons';
import {
  initOpenCti, notifyReady, onClickToDial as onCti, saveCallLog, setPanelVisibility,
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
type Tab = 'dialer' | 'recent' | 'reputation' | 'admin';

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

export function App(): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signedIn, setSignedIn] = useState(!!readSession());
  const [toast, setToast] = useState<{ text: string; type: 'info' | 'error' | 'success' } | null>(null);
  const [ctiReady, setCtiReady] = useState(false);
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
          clearSession();
          setSignedIn(false);
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

  const place = useCallback(async () => {
    if (!firewall || firewall.decision === 'BLOCK') return;
    setBusy(true);
    try {
      const created = await api<{ call: { id: string; fromNumber: string; toNumber: string; normalizedToNumber: string } }>(
        '/calls', {
          method: 'POST',
          body: {
            toNumber: raw,
            auditId: firewall.auditId,
            // Dial exactly the DID the firewall gated. Clicking "Call" on a
            // REQUIRE_REVIEW verdict is the rep's explicit acknowledgement.
            ...(firewall.fromNumber ? { fromNumber: firewall.fromNumber } : {}),
            ...(firewall.decision === 'REQUIRE_REVIEW' ? { acknowledged: true } : {}),
          },
        },
      );
      const callId = created.call.id;
      const tok = await api<{ token: string }>('/telephony/token', { method: 'POST' });
      const { Device } = await import('@twilio/voice-sdk');
      const device = new Device(tok.token, { logLevel: 1 });
      deviceRef.current = device;
      // Surface device-level errors (e.g. AccessTokenInvalid) as a toast.
      // These fire on the Device, not the Connection, so without this handler
      // a bad Twilio token fails silently and the UI just appears to do nothing.
      (device as unknown as { on: (e: string, cb: (a: unknown) => void) => void }).on('error', (err) => {
        const e = err as { message?: string; code?: number } | undefined;
        setToast({ text: `Call error ${e?.code ?? ''}: ${e?.message ?? 'Twilio device error'}`.replace('  ', ' ').trim(), type: 'error' });
        setPhase('preflight');
        setBusy(false);
      });
      await device.register();
      const connection = await device.connect({
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
        try { (device as unknown as { destroy: () => void }).destroy(); } catch { /* noop */ }
      });
      conn.on('cancel', () => {
        persistSid(); setPhase('wrapup');
        try { (device as unknown as { destroy: () => void }).destroy(); } catch { /* noop */ }
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
    } finally { setBusy(false); }
  }, [firewall, raw, ctiContext]);

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
    deviceRef.current = null; connectionRef.current = null;
  }, []);

  const submitDisposition = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api(`/calls/${active.callId}/disposition`, {
        method: 'POST',
        body: {
          disposition,
          notes,
          durationSeconds: elapsed,
          // When we have the click-to-dial record we log via Open CTI below;
          // tell the backend to skip its own sync so the call isn't logged twice.
          skipSalesforceSync: !!active.recordId,
        },
      });
      // If we know the SF record from the click-to-dial event, ALSO log via
      // Open CTI so the Task attaches to that exact record (no SOSL needed).
      if (active.recordId) {
        const ok = await saveCallLog({
          Subject: `Outbound Call - ${active.toNumber}`,
          Status: 'Completed',
          TaskSubtype: 'Call',
          CallType: 'Outbound',
          CallDisposition: disposition,
          CallDurationInSeconds: elapsed,
          Description: notes || '',
          WhoId: active.objectType === 'Lead' || active.objectType === 'Contact' ? active.recordId : undefined,
          WhatId: active.objectType !== 'Lead' && active.objectType !== 'Contact' ? active.recordId : undefined,
        });
        setToast({
          text: ok ? `Call logged · attached to ${active.recordName ?? active.objectType}` : 'Call logged locally',
          type: 'success',
        });
      } else {
        setToast({ text: 'Call logged. Salesforce sync queued.', type: 'success' });
      }
      reset();
    } catch (e) {
      setToast({ text: `Could not save: ${(e as Error).message}`, type: 'error' });
    } finally { setBusy(false); }
  }, [active, disposition, notes, elapsed, reset]);

  // Global keyboard input for the dialpad (only while it's visible)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (tab !== 'dialer') return;
      if (phase !== 'idle' && phase !== 'preflight') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9*#+]$/.test(e.key)) { e.preventDefault(); setRaw((v) => v + e.key); setFirewall(null); setPhase('idle'); }
      else if (e.key === 'Backspace') { e.preventDefault(); setRaw((v) => v.slice(0, -1)); setFirewall(null); setPhase('idle'); }
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
            <span className={`presence-dot ${ctiReady ? '' : 'warn'}`} />
            {ctiReady ? 'Salesforce CTI connected' : 'Standalone'}
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

  const body = inCall && active ? (
    phase === 'wrapup' ? (
      <WrapupForm
        toNumber={active.toNumber}
        timer={timer}
        recordName={active.recordName}
        disposition={disposition}
        onDisposition={setDisposition}
        notes={notes}
        onNotes={setNotes}
        busy={busy}
        onSubmit={submitDisposition}
        onDiscard={reset}
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
    <RecentCalls />
  ) : tab === 'reputation' ? (
    <ReputationPanel />
  ) : tab === 'admin' ? (
    <AdminPanel />
  ) : (
    <div className="dialer">
      <Dialpad
        raw={raw}
        placeholder={ctiReady ? 'Click a phone in Salesforce, or type' : 'Type a number'}
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
    </div>
  );

  const navItems: Array<{ id: Tab; label: string; icon: JSX.Element }> = [
    { id: 'dialer', label: 'Dial', icon: <GridIcon /> },
    { id: 'recent', label: 'Recent', icon: <ClockIcon /> },
    { id: 'reputation', label: 'Reputation', icon: <ShieldIcon /> },
    // Number-pool management — admins only (server enforces 403 regardless).
    ...(me.user.isAdmin ? [{ id: 'admin' as Tab, label: 'Numbers', icon: <SettingsIcon /> }] : []),
  ];

  return (
    <div className="app">
      {header}
      {sfBanner}
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
