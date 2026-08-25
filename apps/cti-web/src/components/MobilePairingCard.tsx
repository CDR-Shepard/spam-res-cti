import { useCallback, useEffect, useState } from 'react';
import { listPairedDevices, revokeDevice, startPairing, type PairedDevice, type PairStartResponse } from '../mobile-api';
import { relativeTime } from '../format';
import { PhoneIcon } from '../icons';

/** Pure — "m:ss" remaining until `expiresAt`, clamped at 0:00. Mirrors
 *  DialerPanel.tsx's retryCountdown. */
export function pairCodeCountdown(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pure — true once the minted code's countdown has reached zero. */
export function pairCodeExpired(expiresAt: string, now: number): boolean {
  return Date.parse(expiresAt) <= now;
}

interface Props {
  onToast: (t: { text: string; type: 'info' | 'error' | 'success' }) => void;
}

/**
 * Rep self-service iPhone pairing: mint a short-lived code, show it with a
 * live countdown, and list/revoke the rep's already-paired devices.
 */
export function MobilePairingCard({ onToast }: Props): JSX.Element {
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState<PairStartResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const r = await listPairedDevices();
      setDevices(r.devices);
    } catch {
      /* best-effort — the card just shows no list */
    }
  }, []);

  useEffect(() => { void refreshDevices(); }, [refreshDevices]);

  // Tick the countdown while a code is showing, and drop it once it expires
  // so the rep isn't looking at a dead code with no explanation.
  useEffect(() => {
    if (!code) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [code]);
  useEffect(() => {
    if (code && pairCodeExpired(code.expiresAt, now)) setCode(null);
  }, [code, now]);

  const getCode = useCallback(async () => {
    setPairing(true);
    try {
      const r = await startPairing();
      setNow(Date.now());
      setCode(r);
    } catch (e) {
      onToast({ text: (e as Error).message, type: 'error' });
    } finally {
      setPairing(false);
    }
  }, [onToast]);

  const revoke = useCallback(async (id: string) => {
    setRevokingId(id);
    try {
      await revokeDevice(id);
      await refreshDevices();
      onToast({ text: 'Device unpaired.', type: 'success' });
    } catch (e) {
      onToast({ text: (e as Error).message, type: 'error' });
    } finally {
      setRevokingId(null);
    }
  }, [refreshDevices, onToast]);

  return (
    <div className="set-list">
      <div className="set-row">
        <div className="icon"><PhoneIcon /></div>
        <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="name">Pair your iPhone</div>
          <div className="sub">
            Get caller ID on your phone for numbers in Salesforce. Open the
            companion app and enter this code.
          </div>
          {code ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: 3, fontVariantNumeric: 'tabular-nums' }}>
                {code.code}
              </span>
              <span className="sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
                expires in {pairCodeCountdown(code.expiresAt, now)}
              </span>
            </div>
          ) : (
            <button
              className="btn primary"
              style={{ padding: '6px 12px', fontSize: 12, alignSelf: 'flex-start', marginTop: 4 }}
              disabled={pairing}
              onClick={() => void getCode()}
            >
              {pairing ? <span className="spinner" /> : 'Get pairing code'}
            </button>
          )}
          {devices && devices.length === 0 && (
            <div className="sub">No devices paired yet.</div>
          )}
        </div>
      </div>
      {devices?.map((d) => (
        <div className="set-row" key={d.id}>
          <div className="icon"><PhoneIcon /></div>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="name">{d.label}</div>
            <div className="sub" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span>Last synced {relativeTime(d.lastSeenAt)}</span>
              <button
                className="btn ghost"
                style={{ padding: '2px 10px', fontSize: 11 }}
                disabled={revokingId === d.id}
                onClick={() => void revoke(d.id)}
              >
                {revokingId === d.id ? <span className="spinner" /> : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
