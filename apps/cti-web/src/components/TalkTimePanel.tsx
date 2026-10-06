import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { getTalkTime, type TalkTimeReport } from '../talk-time-api';
import { formatDay, formatHms, rangeFor, type RangeShortcut } from '../talk-time-format';

const SHORTCUTS: ReadonlyArray<{ id: RangeShortcut; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'last7', label: 'Last 7 days' },
];

const GENERIC_ERROR = 'Could not load talk time.';

/** The server's own 400 message (e.g. "at most 92 days") when there is one —
 *  parseTalkRange's error is always a plain string — else the generic line
 *  (final review M8). */
function talkTimeErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 400) {
    const data = err.data as { error?: unknown } | null;
    if (data && typeof data.error === 'string') return data.error;
  }
  return GENERIC_ERROR;
}

/**
 * Admin-only Talk time report (talk-time spec): per rep, over the org's Pacific
 * days From–To — talk time on every connected call (click-to-dial, power dial,
 * answered inbound), connected calls, power-dial talk, and time on the power
 * dialer (counted while dialing or talking; quiet stretches over 15 minutes are
 * left out). Tap a rep for their days.
 */
export function TalkTimePanel(): JSX.Element {
  const [range, setRange] = useState(() => rangeFor('today'));
  const [report, setReport] = useState<TalkTimeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Only the latest request may land: a quick second range must not be
  // overwritten by the first one's slower answer.
  const latest = useRef(0);

  const load = useCallback(async (from: string, to: string) => {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await getTalkTime(from, to);
      if (mine === latest.current) setReport(next);
    } catch (err) {
      // Clear the stale report too (final review M8): otherwise a new range's
      // error sits over the PREVIOUS range's table, which looks like it still
      // answers the inputs shown above it.
      if (mine === latest.current) {
        setError(talkTimeErrorMessage(err));
        setReport(null);
      }
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range.from, range.to);
  }, [load, range.from, range.to]);

  const setFrom = (from: string): void => {
    if (from) setRange((r) => ({ from, to: from > r.to ? from : r.to }));
  };
  const setTo = (to: string): void => {
    if (to) setRange((r) => ({ from: to < r.from ? to : r.from, to }));
  };
  const powerDialTotal = report ? report.reps.reduce((t, r) => t + r.bySource.powerDial.seconds, 0) : 0;

  return (
    <div className="calllog">
      <div className="calllog-head">
        <div className="calllog-title">Talk time</div>
      </div>
      <div className="calllog-head">
        <input type="date" className="calllog-filter" aria-label="From" value={range.from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="calllog-filter" aria-label="To" value={range.to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="calllog-head">
        {SHORTCUTS.map((s) => (
          <button key={s.id} className="btn ghost" onClick={() => setRange(rangeFor(s.id))}>{s.label}</button>
        ))}
      </div>
      <div className="calllog-summary">
        Pacific time. Talk time counts connected calls — click-to-dial, power dial and answered inbound. On dialer counts
        the rep&rsquo;s power-dial time while dialing or talking; quiet stretches over 15 minutes are left out.
      </div>
      {error && <div className="admin-err" role="alert">{error}</div>}
      {loading && !report && <div className="empty-state"><span className="spinner lg" /></div>}
      {loading && report && <div className="calllog-loading"><span className="spinner" /> Loading talk time…</div>}
      {report && (
        <div className="calllog-scroll">
          <table className="calllog-table">
            <thead>
              <tr>
                <th>Rep</th><th>Talk time</th><th>Connected</th><th>Power-dial talk</th><th>On dialer</th>
              </tr>
            </thead>
            <tbody>
              {report.reps.map((r) => (
                <Fragment key={r.userId}>
                  <tr>
                    <td>
                      <button className="btn ghost" aria-expanded={open === r.userId} onClick={() => setOpen(open === r.userId ? null : r.userId)}>
                        {r.name}
                      </button>
                    </td>
                    <td className="dur">{formatHms(r.talkSeconds)}</td>
                    <td className="dur">{r.connectedCalls}</td>
                    <td className="dur">{formatHms(r.bySource.powerDial.seconds)}</td>
                    <td className="dur">{formatHms(r.dialerSeconds)}</td>
                  </tr>
                  {open === r.userId &&
                    r.days.map((d) => (
                      <tr key={d.day}>
                        <td className="nowrap">{formatDay(d.day)}</td>
                        <td className="dur">{formatHms(d.talkSeconds)}</td>
                        <td className="dur">{d.connectedCalls}</td>
                        <td />
                        <td className="dur">{formatHms(d.dialerSeconds)}</td>
                      </tr>
                    ))}
                </Fragment>
              ))}
              {report.reps.length === 0 ? (
                <tr><td colSpan={5} className="calllog-empty">No talk time in this range.</td></tr>
              ) : (
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="dur">{formatHms(report.totals.talkSeconds)}</td>
                  <td className="dur">{report.totals.connectedCalls}</td>
                  <td className="dur">{formatHms(powerDialTotal)}</td>
                  <td className="dur">{formatHms(report.totals.dialerSeconds)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
