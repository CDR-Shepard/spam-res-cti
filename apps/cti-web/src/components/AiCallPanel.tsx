import { useCallback, useEffect, useRef, useState } from 'react';
import {
  aiCallErrorMessage,
  blockWords,
  getAiCall,
  isLiveRow,
  isTerminalStatus,
  listAiCalls,
  outcomeWords,
  startAiCall,
  statusWords,
  type AiCallRow,
  type AiTranscriptEntry,
} from '../ai-calls-api';
import { formatDuration, formatE164 } from '../format';
import './AiCallPanel.css';

/** Poll this often while any call is live (or only just ended)… */
export const FAST_POLL_MS = 4_000;
/** …and this often otherwise. Focus also reloads. */
export const SLOW_POLL_MS = 30_000;
export const LIST_LIMIT = 20;

interface AiCallPanelProps {
  isAdmin: boolean;
  /** AI_VOICE_TEST_NUMBERS (E.164) — admins only; [] for reps. */
  testNumbers: string[];
  /** AI calling is on (GET /ai-calls/availability). */
  available: boolean;
}

/** "Tue 9:41 AM" in the rep's own time zone. */
function formatStarted(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function chipTone(status: string): string {
  if (status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'transferred' || status === 'completed') return 'done';
  return 'live';
}

const ROLE_WORDS: Readonly<Record<string, string>> = { agent: 'AI', caller: 'Caller' };

function Transcript({ entries }: { entries: AiTranscriptEntry[] }): JSX.Element {
  if (entries.length === 0) return <div className="ai-call-dim">No transcript yet.</div>;
  return (
    <ol className="ai-transcript" aria-label="Transcript">
      {entries.map((e, i) => (
        <li key={i} className={`ai-line ${e.role}`}>
          {ROLE_WORDS[e.role] && <span className="ai-who">{ROLE_WORDS[e.role]}:</span>} {e.text}
        </li>
      ))}
    </ol>
  );
}

function TestCallBox({ testNumbers, onPlaced }: { testNumbers: string[]; onPlaced: () => void }): JSX.Element {
  const [to, setTo] = useState(testNumbers[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  const place = async (): Promise<void> => {
    const testTo = to.trim();
    if (!testTo || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await startAiCall({ testTo });
      setMessage({ text: `Calling ${formatE164(testTo) || testTo} — answer your phone.`, bad: false });
      onPlaced();
    } catch (err) {
      setMessage({ text: aiCallErrorMessage(err), bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ai-test-box" aria-label="Test AI call">
      <div className="ai-test-title">Test AI call</div>
      {testNumbers.length > 0 ? (
        <div className="ai-test-quick">
          {testNumbers.map((n) => (
            <button key={n} className={`btn compact ${to === n ? 'active' : ''}`} onClick={() => setTo(n)}>
              {formatE164(n)}
            </button>
          ))}
        </div>
      ) : (
        <div className="ai-call-dim">No test numbers are set (AI_VOICE_TEST_NUMBERS), so a test call will be refused.</div>
      )}
      <div className="ai-test-form">
        <input
          className="field"
          aria-label="Test number"
          placeholder="+1 555 555 5555"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void place(); }}
        />
        <button className="btn primary" onClick={() => void place()} disabled={busy || !to.trim()}>
          {busy ? <><span className="spinner" /> Starting…</> : 'Start test call'}
        </button>
      </div>
      {message && (
        <div className={message.bad ? 'ai-call-error' : 'ai-call-ok'} role={message.bad ? 'alert' : 'status'}>{message.text}</div>
      )}
    </section>
  );
}

interface Detail { row: AiCallRow | null; error: string | null }

/**
 * AI calls: the rep's recent AI calls (admins: the whole org), newest first —
 * status, outcome, number, start time, duration and summary; tap one for its
 * transcript. Live calls refresh every few seconds. Admins also get a Test AI
 * call box for the configured test numbers.
 */
export function AiCallPanel({ isAdmin, testNumbers, available }: AiCallPanelProps): JSX.Element {
  const [rows, setRows] = useState<AiCallRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const latest = useRef(0);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const row = await getAiCall(id);
      setDetails((d) => ({ ...d, [id]: { row, error: null } }));
    } catch {
      setDetails((d) => ({ ...d, [id]: { row: d[id]?.row ?? null, error: "Couldn't load the transcript." } }));
    }
  }, []);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const next = await listAiCalls(LIST_LIMIT);
      if (mine !== latest.current) return;
      setRows(next);
      setError(null);
    } catch {
      if (mine === latest.current) setError("Couldn't load AI calls.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Fast while something is live; slow otherwise; never while the page is hidden.
  const fast = rows?.some((r) => isLiveRow(r, Date.now())) ?? false;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, fast ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => window.clearInterval(id);
  }, [fast, load]);

  useEffect(() => {
    const onFocus = (): void => { void load(); };
    const onVisible = (): void => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // An open row whose list entry changed (a live call moved on) gets its
  // transcript fetched again.
  const openRow = rows?.find((r) => r.id === openId);
  const openDetailUpdated = openId ? details[openId]?.row?.updatedAt : undefined;
  useEffect(() => {
    if (!openId || !openRow || !openDetailUpdated) return;
    if (openRow.updatedAt !== openDetailUpdated) void loadDetail(openId);
  }, [openId, openRow?.updatedAt, openDetailUpdated, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string): void => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    void loadDetail(id);
  };

  return (
    <div className="calllog ai-calls">
      <div className="calllog-head">
        <div className="calllog-title">AI calls</div>
        <button className="btn ghost compact" onClick={() => void load()}>Refresh</button>
      </div>
      {!available && <div className="ai-call-error" role="status">AI calling is turned off — new AI calls will be refused.</div>}
      {isAdmin && <TestCallBox testNumbers={testNumbers} onPlaced={() => void load()} />}
      {error && <div className="admin-err" role="alert">{error}</div>}
      {rows === null && !error && <div className="empty-state"><span className="spinner lg" /></div>}
      {rows !== null && rows.length === 0 && (
        <div className="calllog-empty">No AI calls yet.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="ai-call-list">
          {rows.map((r) => {
            const open = openId === r.id;
            const detail = details[r.id];
            const outcome = r.status === 'blocked' ? blockWords(r.blockReason) || outcomeWords(r.outcome) : outcomeWords(r.outcome);
            return (
              <li key={r.id} className="ai-call-item">
                <button className="ai-call-head" aria-expanded={open} onClick={() => toggle(r.id)}>
                  <span className={`ai-chip ${chipTone(r.status)}`}>{statusWords(r.status)}</span>
                  <span className="ai-call-to">{formatE164(r.toE164) || r.toE164}</span>
                  {r.isTest && <span className="ai-chip test">Test</span>}
                  <span className="ai-call-when">{formatStarted(r.startedAt ?? r.createdAt)}</span>
                  {isTerminalStatus(r.status) && <span className="ai-call-dur">{formatDuration(r.durationSeconds)}</span>}
                </button>
                {outcome && <div className="ai-call-outcome">{outcome}</div>}
                {r.summary && <div className="ai-call-summary">{r.summary}</div>}
                {open && (
                  <div className="ai-call-detail">
                    {detail?.error && <div className="ai-call-error" role="alert">{detail.error}</div>}
                    {!detail ? (
                      <div className="ai-call-dim"><span className="spinner" /> Loading transcript…</div>
                    ) : detail.row ? (
                      <Transcript entries={Array.isArray(detail.row.transcript) ? detail.row.transcript : []} />
                    ) : null}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Nav icon for the AI calls tab (sparkles, in icons.tsx's style). */
export const AiCallsIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
  </svg>
);
