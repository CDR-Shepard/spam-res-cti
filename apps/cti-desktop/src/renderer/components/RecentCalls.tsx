/**
 * Recent calls list. Identical component in cti-web and cti-desktop.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatDuration, formatE164, relativeTime } from '../format';
import { CheckCircleIcon, ClockIcon, PhoneOffIcon, PhoneOutgoingIcon } from '../icons';

interface CallRow {
  id: string;
  toNumber: string;
  normalizedToNumber: string;
  fromNumber: string;
  status: string;
  disposition: string | null;
  durationSeconds: number | null;
  salesforceTaskId: string | null;
  createdAt: string;
}

function classify(row: CallRow): 'connected' | 'missed' | 'outgoing' {
  if (row.disposition === 'Connected' || (row.durationSeconds ?? 0) > 5) return 'connected';
  if (row.status === 'no_answer' || row.status === 'busy' || row.status === 'failed') return 'missed';
  return 'outgoing';
}

export function RecentCalls(): JSX.Element {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ calls: CallRow[] }>('/calls?limit=50');
        setCalls(data.calls);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="empty-state"><span className="spinner lg" /></div>;
  if (err) return <div className="empty-state bad">{err}</div>;
  if (calls.length === 0) {
    return (
      <div className="empty-state">
        <ClockIcon className="empty-icon" />
        No calls yet
        <span className="empty-hint">Your call history and Salesforce sync status will show up here.</span>
      </div>
    );
  }

  return (
    <div className="list">
      {calls.map((c) => {
        const kind = classify(c);
        const Icon = kind === 'missed' ? PhoneOffIcon : kind === 'connected' ? CheckCircleIcon : PhoneOutgoingIcon;
        return (
          <div className={`row-item ${kind}`} key={c.id}>
            <div className="dir"><Icon /></div>
            <div className="info">
              <div className="num">{formatE164(c.normalizedToNumber)}</div>
              <div className="meta">{relativeTime(c.createdAt)} · {c.disposition ?? c.status.replace(/_/g, ' ')}</div>
            </div>
            <div className="right">
              <span className="dur">{formatDuration(c.durationSeconds)}</span>
              {c.salesforceTaskId
                ? <span className="sync ok">Synced</span>
                : <span className="sync">Local</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
