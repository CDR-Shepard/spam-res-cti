import { useCallback, useEffect, useState } from 'react';
import {
  HOLD_MUSIC_CHOICES,
  HOLD_MUSIC_LABELS,
  YOUTUBE_LINK_ERROR,
  parseYouTubeLink,
  youtubeLinkFor,
  type HoldMusicChoice,
  type HoldMusicSetting,
} from '@cti/contracts';
import { api } from '../api';
import { formatE164 } from '../format';
import { PhoneOutgoingIcon, ZapIcon } from '../icons';
import { MobilePairingCard } from './MobilePairingCard';

interface Props {
  /** Current failover number (E.164) or null, from /auth/me. */
  forwardE164: string | null;
  /** Hold music in the rep's headset while a Power Dial run waits between calls, from /auth/me. */
  holdMusic: HoldMusicSetting;
  /** Re-fetch /auth/me after a change so the panel reflects server truth. */
  onSaved: () => Promise<void> | void;
  onToast: (t: { text: string; type: 'info' | 'error' | 'success' }) => void;
}

/** The link box's saved-selection line, or null when nothing is stored yet. */
function savedYoutubeLine(holdMusic: HoldMusicSetting): string | null {
  if (holdMusic.choice !== 'youtube' || !holdMusic.youtube) return null;
  return `YouTube · ${holdMusic.youtube.listId ? 'playlist' : 'video'}`;
}

/** The success toast text for a choice that just took effect. */
function toastForChoice(choice: HoldMusicChoice): string {
  return choice === 'off'
    ? 'Hold music off — silence between calls from your next run.'
    : `Hold music: ${HOLD_MUSIC_LABELS[choice]} — from your next run.`;
}

/** The server's `{ error }` sentence from a PATCH failure, when there is one —
 *  duck-typed on the response shape (not `instanceof ApiError`) so it reads
 *  any object carrying `data.error`, real ApiError or otherwise. */
function patchErrorMessage(e: unknown): string | null {
  if (!e || typeof e !== 'object' || !('data' in e)) return null;
  const data = (e as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || !('error' in data)) return null;
  const msg = (data as { error?: unknown }).error;
  return typeof msg === 'string' ? msg : null;
}

/**
 * Rep self-service settings: no-answer call forwarding (the personal failover
 * number every DID assigned to this rep rolls an unanswered callback to, after
 * a 10s softphone ring, before voicemail) and what hold music, if any, Power
 * Dial plays in the headset between calls — six styles, Off, or the rep's own
 * YouTube playlist/video.
 */
export function SettingsPanel({ forwardE164, holdMusic, onSaved, onToast }: Props): JSX.Element {
  const [draft, setDraft] = useState(forwardE164 ?? '');
  const [saving, setSaving] = useState(false);
  const [savingMusic, setSavingMusic] = useState(false);
  const [picked, setPicked] = useState<HoldMusicChoice>(holdMusic.choice);
  const [link, setLink] = useState(() => (holdMusic.youtube ? youtubeLinkFor(holdMusic.youtube) ?? '' : ''));
  const [linkError, setLinkError] = useState<string | null>(null);
  useEffect(() => { setDraft(forwardE164 ?? ''); }, [forwardE164]);
  // Re-sync from server truth (e.g. after onSaved's refetch) so a stale local
  // pick never shows YouTube — or any choice — the server didn't confirm.
  useEffect(() => { setPicked(holdMusic.choice); }, [holdMusic.choice]);
  useEffect(() => {
    setLink(holdMusic.youtube ? youtubeLinkFor(holdMusic.youtube) ?? '' : '');
  }, [holdMusic.youtube]);

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

  const patchHoldMusic = useCallback(async (body: { choice: HoldMusicChoice; youtubeLink?: string }) => {
    setSavingMusic(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { holdMusic: body } });
      await onSaved();
      setLinkError(null);
      onToast({ text: toastForChoice(body.choice), type: 'success' });
      return true;
    } catch (e) {
      const msg = patchErrorMessage(e);
      if (body.choice === 'youtube') {
        // YouTube errors show inline next to the link box, never as a toast.
        setLinkError(msg ?? (e instanceof Error ? e.message : 'Could not save the link.'));
      } else {
        onToast({ text: msg ?? (e instanceof Error ? e.message : 'Could not update hold music.'), type: 'error' });
      }
      return false;
    } finally {
      setSavingMusic(false);
    }
  }, [onSaved, onToast]);

  const pickHoldMusic = useCallback(async (c: HoldMusicChoice) => {
    setPicked(c);
    if (c !== 'youtube') {
      await patchHoldMusic({ choice: c });
      return;
    }
    setLinkError(null);
    // A playlist/video is already stored server-side: restore it immediately
    // rather than making the rep re-paste a link they already gave us.
    if (holdMusic.youtube) await patchHoldMusic({ choice: 'youtube' });
    // Otherwise wait for the rep to paste a link and hit Save.
  }, [holdMusic.youtube, patchHoldMusic]);

  const saveYouTube = useCallback(async () => {
    const parsed = parseYouTubeLink(link);
    if (!parsed) { setLinkError(YOUTUBE_LINK_ERROR); return; }
    await patchHoldMusic({ choice: 'youtube', youtubeLink: link.trim() });
  }, [link, patchHoldMusic]);

  const savedLine = savedYoutubeLine(holdMusic);

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
          <div className="icon" style={{ color: holdMusic.choice !== 'off' ? 'var(--good)' : 'var(--text-muted)' }}>
            <ZapIcon />
          </div>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="name">Hold music during Power Dial</div>
            <div className="sub">
              Music plays in your headset while the dialer works between calls. Pick a
              style, choose Off, or play your own YouTube playlist. Takes effect on your
              next run.
            </div>
            <select
              aria-label="Hold music"
              className="set-select"
              value={picked}
              disabled={savingMusic}
              onChange={(e) => void pickHoldMusic(e.target.value as HoldMusicChoice)}
            >
              {HOLD_MUSIC_CHOICES.map((c) => <option key={c} value={c}>{HOLD_MUSIC_LABELS[c]}</option>)}
            </select>
            {picked === 'youtube' && (
              <div className="set-youtube">
                <input
                  className="set-input"
                  placeholder="Paste a YouTube playlist or video link"
                  value={link}
                  onChange={(e) => { setLink(e.target.value); setLinkError(null); }}
                />
                <button className="btn primary" disabled={savingMusic} onClick={() => void saveYouTube()}>Save</button>
                {linkError && <div className="set-error">{linkError}</div>}
                {savedLine && <div className="sub">{savedLine}</div>}
              </div>
            )}
          </div>
        </div>
      </div>
      <MobilePairingCard onToast={onToast} />
    </>
  );
}
