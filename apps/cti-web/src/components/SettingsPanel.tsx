import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatE164 } from '../format';
import { PhoneOutgoingIcon, ZapIcon } from '../icons';
import { MobilePairingCard } from './MobilePairingCard';

interface Props {
  /** Current failover number (E.164) or null, from /auth/me. */
  forwardE164: string | null;
  /** Hold music in the rep's headset while a Power Dial run waits between calls, from /auth/me. */
  holdMusic: boolean;
  /** Re-fetch /auth/me after a change so the panel reflects server truth. */
  onSaved: () => Promise<void> | void;
  onToast: (t: { text: string; type: 'info' | 'error' | 'success' }) => void;
}

/**
 * Rep self-service settings: no-answer call forwarding (the personal failover
 * number every DID assigned to this rep rolls an unanswered callback to, after
 * a 10s softphone ring, before voicemail) and whether Power Dial plays hold
 * music in the headset between calls.
 */
export function SettingsPanel({ forwardE164, holdMusic, onSaved, onToast }: Props): JSX.Element {
  const [draft, setDraft] = useState(forwardE164 ?? '');
  const [saving, setSaving] = useState(false);
  const [savingMusic, setSavingMusic] = useState(false);
  useEffect(() => { setDraft(forwardE164 ?? ''); }, [forwardE164]);

  const save = useCallback(async (next: string | null) => {
    setSaving(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { noAnswerForwardE164: next } });
      await onSaved();
      onToast({ text: next ? 'Call forwarding updated.' : 'Call forwarding turned off.', type: 'success' });
    } catch (e) {
      onToast({ text: (e as Error).message, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [onSaved, onToast]);

  const saveHoldMusic = useCallback(async (next: boolean) => {
    setSavingMusic(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { dialerHoldMusic: next } });
      await onSaved();
      onToast({
        text: next ? 'Hold music on.' : 'Hold music off — silence between calls from your next run.',
        type: 'success',
      });
    } catch (e) {
      onToast({ text: (e as Error).message, type: 'error' });
    } finally {
      setSavingMusic(false);
    }
  }, [onSaved, onToast]);

  return (
    <>
      <div className="set-list">
        <div className="set-row">
          <div className="icon" style={{ color: forwardE164 ? 'var(--good)' : 'var(--text-muted)' }}>
            <PhoneOutgoingIcon />
          </div>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="name">Call forwarding</div>
            <div className="sub">
              If you don't pick up a callback within 10s, it rings this number before
              going to voicemail — on every number assigned to you.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input
                className="field"
                inputMode="tel"
                placeholder="+1 555 010 0123 (your mobile)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { const v = draft.trim(); if (v) void save(v); } }}
                style={{ fontSize: 13, flex: 1 }}
              />
              <button
                className="btn primary"
                style={{ padding: '6px 12px', fontSize: 12 }}
                disabled={saving || !draft.trim() || draft.trim() === (forwardE164 ?? '')}
                onClick={() => void save(draft.trim())}
              >
                {saving ? <span className="spinner" /> : 'Save'}
              </button>
            </div>
            {forwardE164 && (
              <div
                className="sub"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
              >
                <span style={{ color: 'var(--good)' }}>Forwarding to {formatE164(forwardE164)}</span>
                <button
                  className="btn ghost"
                  style={{ padding: '2px 10px', fontSize: 11 }}
                  disabled={saving}
                  onClick={() => { setDraft(''); void save(null); }}
                >
                  Turn off
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="set-row">
          <div className="icon" style={{ color: holdMusic ? 'var(--good)' : 'var(--text-muted)' }}>
            <ZapIcon />
          </div>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="name">Hold music during Power Dial</div>
            <div className="sub">
              Music plays in your headset while the dialer works between calls. Turn it
              off if you would rather hear the room. Takes effect on your next run.
            </div>
            <div style={{ marginTop: 4 }}>
              <button
                role="switch"
                aria-checked={holdMusic}
                className={`btn ${holdMusic ? 'primary' : 'ghost'}`}
                style={{ padding: '6px 12px', fontSize: 12 }}
                disabled={savingMusic}
                onClick={() => void saveHoldMusic(!holdMusic)}
              >
                {savingMusic ? <span className="spinner" /> : holdMusic ? 'Hold music: On' : 'Hold music: Off'}
              </button>
            </div>
          </div>
        </div>
      </div>
      <MobilePairingCard onToast={onToast} />
    </>
  );
}
