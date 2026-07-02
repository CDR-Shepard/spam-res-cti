/**
 * Admin-only org call log. Lists actual placed/received calls with the real
 * (Twilio-reported) duration, filterable by rep. Reads GET /admin/calls.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatE164 } from '../format';

interface CallRow {
  id: string;
  userId: string;
  direction: string | null;
  fromNumber: string;
  toNumber: string;
  normalizedToNumber: string;
  status: string;
  disposition: string | null;
  durationSeconds: number | null;
  startedAt: string | null;
  createdAt: string;
  salesforceTaskId: string | null;
}
interface Rep {
  id: string;
  email: string;
  displayName: string | null;
}

function fmtDuration(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function CallLog(): JSX.Element {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [repFilter, setRepFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [c, r] = await Promise.all([
        api<{ calls: CallRow[] }>(
          `/admin/calls?limit=500${repFilter !== 'all' ? `&userId=${repFilter}` : ''}`,
        ),
        api<{ reps: Rep[] }>('/admin/reps'),
      ]);
      setCalls(c.calls);
      setReps(r.reps);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [repFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const repName = useMemo(
    () => Object.fromEntries(reps.map((r) => [r.id, r.displayName || r.email.split('@')[0]])),
    [reps],
  );
  const totalTalk = useMemo(() => calls.reduce((a, c) => a + (c.durationSeconds ?? 0), 0), [calls]);
  const connected = useMemo(() => calls.filter((c) => (c.durationSeconds ?? 0) > 0).length, [calls]);

  if (loading) return <div className="empty-state"><span className="spinner lg" /></div>;

  return (
    <div className="calllog">
      <div className="calllog-head">
        <div className="calllog-title">Call log <span className="count">{calls.length}</span></div>
        <select
          className="calllog-filter"
          value={repFilter}
          onChange={(e) => { setRepFilter(e.target.value); setLoading(true); }}
        >
          <option value="all">All reps</option>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>{r.displayName || r.email}</option>
          ))}
        </select>
      </div>
      {err && <div className="admin-err">{err}</div>}
      <div className="calllog-summary">
        {calls.length} calls · {connected} connected · {fmtDuration(totalTalk)} total talk time
      </div>
      <div className="calllog-scroll">
        <table className="calllog-table">
          <thead>
            <tr>
              <th>Time</th><th>Rep</th><th>Dir</th><th>Number</th><th>Caller ID</th>
              <th>Dur</th><th>Disposition</th><th>SF</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => {
              const inbound = c.direction === 'inbound';
              return (
                <tr key={c.id}>
                  <td className="nowrap">{fmtTime(c.createdAt)}</td>
                  <td>{repName[c.userId] ?? '—'}</td>
                  <td>{inbound ? 'In' : 'Out'}</td>
                  <td className="nowrap">{formatE164(inbound ? c.fromNumber : c.normalizedToNumber || c.toNumber)}</td>
                  <td className="nowrap">{formatE164(inbound ? c.normalizedToNumber : c.fromNumber)}</td>
                  <td className="dur">{fmtDuration(c.durationSeconds)}</td>
                  <td>{c.disposition ?? c.status}</td>
                  <td>{c.salesforceTaskId ? '✓' : '—'}</td>
                </tr>
              );
            })}
            {calls.length === 0 && (
              <tr><td colSpan={8} className="calllog-empty">No calls yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
