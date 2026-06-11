import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatE164 } from '../format';
import { CheckCircleIcon, CloudIcon, MoonIcon, PaletteIcon, PhoneIcon, PlusIcon, SunIcon, UserIcon, ZapIcon } from '../icons';
import { useApp } from '../state';

interface OutboundNumber {
  id: string;
  e164: string;
  label: string | null;
  provider: string;
  active: boolean;
  health: string;
}

export function SettingsView(): JSX.Element {
  const { me, refreshMe, setToast, signOut, theme, setTheme, customDisplayName, setCustomDisplayName } = useApp();
  const [nameDraft, setNameDraft] = useState(customDisplayName ?? '');
  useEffect(() => { setNameDraft(customDisplayName ?? ''); }, [customDisplayName]);
  const [numbers, setNumbers] = useState<OutboundNumber[]>([]);
  const [newNumber, setNewNumber] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [sfPending, setSfPending] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<'ok' | 'err' | 'unknown'>('unknown');
  const [tokenStatusText, setTokenStatusText] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const loadNumbers = useCallback(async () => {
    try {
      const data = await api<{ numbers: OutboundNumber[] }>('/admin/outbound-numbers');
      setNumbers(data.numbers);
    } catch (e) { setToast({ text: (e as Error).message, type: 'error' }); }
  }, [setToast]);

  useEffect(() => { void loadNumbers(); }, [loadNumbers]);

  const startSalesforce = useCallback(async () => {
    setSfPending(true);
    try {
      const { authUrl, handshake } = await api<{ authUrl: string; handshake: string }>(
        '/auth/salesforce/start', { method: 'POST' },
      );
      await window.cti.openExternal(authUrl);
      const started = Date.now();
      const poll = async () => {
        if (Date.now() - started > 5 * 60 * 1000) {
          setSfPending(false);
          setToast({ text: 'Salesforce connect timed out.', type: 'error' });
          return;
        }
        const { status } = await api<{ status: string }>(`/auth/salesforce/status?handshake=${encodeURIComponent(handshake)}`);
        if (status === 'connected') {
          setSfPending(false);
          setToast({ text: 'Salesforce connected.', type: 'success' });
          await refreshMe();
          return;
        }
        if (status === 'failed') {
          setSfPending(false);
          setToast({ text: 'Salesforce connect failed.', type: 'error' });
          return;
        }
        setTimeout(poll, 1500);
      };
      void poll();
    } catch (e) {
      setSfPending(false);
      setToast({ text: (e as Error).message, type: 'error' });
    }
  }, [refreshMe, setToast]);

  const disconnectSalesforce = useCallback(async () => {
    try {
      await api('/auth/salesforce/disconnect', { method: 'POST' });
      await refreshMe();
      setToast({ text: 'Salesforce disconnected.', type: 'info' });
    } catch (e) { setToast({ text: (e as Error).message, type: 'error' }); }
  }, [refreshMe, setToast]);

  const addNumber = useCallback(async () => {
    if (!newNumber.trim()) return;
    try {
      await api('/admin/outbound-numbers', {
        method: 'POST',
        body: { e164: newNumber.trim(), label: newLabel.trim() || undefined },
      });
      setNewNumber(''); setNewLabel(''); setAdding(false);
      await loadNumbers();
    } catch (e) { setToast({ text: (e as Error).message, type: 'error' }); }
  }, [newNumber, newLabel, loadNumbers, setToast]);

  const checkProvider = useCallback(async () => {
    try {
      await api<{ token: string; provider: string; expiresAt: string }>('/telephony/token', { method: 'POST' });
      setTokenStatus('ok');
      setTokenStatusText('Twilio Voice token minted');
    } catch (e) {
      setTokenStatus('err');
      setTokenStatusText((e as Error).message);
    }
  }, []);

  return (
    <>
      <div className="set-list">
        <div className="set-row">
          <div className="icon"><UserIcon /></div>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              className="field"
              placeholder="Your name (shown in the header)"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const next = nameDraft.trim();
                if (next !== (customDisplayName ?? '')) setCustomDisplayName(next || null);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ fontSize: 13 }}
            />
            <div className="sub mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {me?.user.email ?? '—'}
            </div>
          </div>
          <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={signOut}>Sign out</button>
        </div>
      </div>

      <div className="set-list">
        <div className="set-row">
          <div className="icon"><PaletteIcon /></div>
          <div className="label">
            <div className="name">Appearance</div>
            <div className="sub">{theme === 'light' ? 'Light mode' : 'Dark mode'}</div>
          </div>
          <div className="segmented" role="tablist" aria-label="Theme">
            <button
              className={theme === 'dark' ? 'active' : ''}
              onClick={() => setTheme('dark')}
              aria-selected={theme === 'dark'}
            >
              <MoonIcon /> Dark
            </button>
            <button
              className={theme === 'light' ? 'active' : ''}
              onClick={() => setTheme('light')}
              aria-selected={theme === 'light'}
            >
              <SunIcon /> Light
            </button>
          </div>
        </div>
      </div>

      <div className="set-list">
        <div className="set-row">
          <div className="icon" style={{ color: me?.salesforce.connected ? 'var(--good)' : 'var(--text-muted)' }}>
            <CloudIcon />
          </div>
          <div className="label">
            <div className="name">Salesforce</div>
            <div className="sub">
              {me?.salesforce.connected
                ? <span style={{ color: 'var(--good)' }}>Connected · syncing tasks</span>
                : 'Not connected — calls log locally only'}
            </div>
          </div>
          {me?.salesforce.connected ? (
            <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={disconnectSalesforce}>Disconnect</button>
          ) : (
            <button className="btn primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={sfPending} onClick={startSalesforce}>
              {sfPending ? <span className="spinner" /> : 'Connect'}
            </button>
          )}
        </div>
      </div>

      <div className="set-list">
        <div className="set-row">
          <div className="icon" style={{
            color: tokenStatus === 'ok' ? 'var(--good)' : tokenStatus === 'err' ? 'var(--bad)' : 'var(--text-muted)',
          }}>
            <ZapIcon />
          </div>
          <div className="label">
            <div className="name">Telephony</div>
            <div className="sub">{tokenStatusText ?? 'Twilio · click to test'}</div>
          </div>
          <button className="btn ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={checkProvider}>Test</button>
        </div>
      </div>

      <div className="section">
        <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Outbound numbers</span>
          <button
            className="iconbtn"
            style={{ width: 22, height: 22 }}
            onClick={() => setAdding((v) => !v)}
            title={adding ? 'Cancel' : 'Add number'}
          >
            <PlusIcon style={{ width: 14, height: 14, transform: adding ? 'rotate(45deg)' : 'none', transition: 'transform 160ms' }} />
          </button>
        </h3>
        {numbers.length === 0 && !adding && (
          <div className="desc">No numbers registered. Add the caller ID you've verified with your provider.</div>
        )}
        {numbers.map((n) => {
          const healthColor = n.health === 'healthy' ? 'var(--good)'
            : n.health === 'spam_likely' ? 'var(--bad)'
            : n.health === 'degraded' ? 'var(--warn)' : 'var(--text-muted)';
          return (
            <div className="set-row" key={n.id} style={{ padding: '8px 0', border: 0 }}>
              <div className="icon" style={{ color: healthColor }}>
                <PhoneIcon />
              </div>
              <div className="label">
                <div className="name tnum">{formatE164(n.e164)}</div>
                <div className="sub">{n.label ?? n.provider} · {n.health.replace(/_/g, ' ')}</div>
              </div>
              {n.active && <CheckCircleIcon style={{ width: 16, height: 16, color: 'var(--good)' }} />}
            </div>
          );
        })}
        {adding && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <input className="field" placeholder="+15555550123" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} />
            <input className="field" placeholder="Label (optional)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
            <button className="btn primary full" onClick={addNumber}>Add</button>
          </div>
        )}
      </div>
    </>
  );
}
