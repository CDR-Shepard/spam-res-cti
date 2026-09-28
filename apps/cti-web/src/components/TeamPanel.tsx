import { useCallback, useEffect, useState } from 'react';
import { listTeam, resetCti, resetCtiEveryone, setPowerDialer, type TeamUser } from '../team-api';
import { resetPending, resetStatusLine } from '../reset-status';

const nameOf = (u: TeamUser): string => u.displayName ?? u.email;

/**
 * Admin-only Team panel: grant or revoke Power Dialer per user. The server
 * gate (403 power_dialer_disabled) is authoritative and instant; the rep's
 * own tab bar updates on their next /auth/me refresh.
 *
 * It also holds Reset CTI (spec 2026-09-28), for one rep or for everyone but
 * you. A reset signs the rep's web softphone out and clears its sound
 * settings the next time they're not on a call; their iPhone app stays signed
 * in. The status line says whether it has happened yet; Refresh re-reads it.
 */
export function TeamPanel(): JSX.Element {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Every row whose own reset is in flight (another row's click must never
  // re-enable one that is still going — Task 3 review M-a).
  const [resetting, setResetting] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [resettingAll, setResettingAll] = useState(false);

  const load = useCallback(() => listTeam().then((r) => setUsers(r.users)), []);
  useEffect(() => {
    load().catch(() => setError('Could not load the team.'));
  }, [load]);

  async function toggle(u: TeamUser): Promise<void> {
    const next = !u.powerDialerEnabled;
    setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: next } : x)));
    try {
      await setPowerDialer(u.id, next);
    } catch {
      setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: u.powerDialerEnabled } : x)));
      setError(`Could not update ${nameOf(u)}.`);
    }
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setError(null);
    try {
      await load();
    } catch {
      setError('Could not refresh the team.');
    } finally {
      setRefreshing(false);
    }
  }

  async function resetOne(u: TeamUser): Promise<void> {
    setResetting((prev) => new Set(prev).add(u.id));
    setError(null);
    setNotice(null);
    try {
      const { user } = await resetCti(u.id);
      setUsers((prev) => prev!.map((x) => (x.id === user.id
        ? { ...x, ctiResetRequestedAt: user.ctiResetRequestedAt, ctiResetCompletedAt: user.ctiResetCompletedAt }
        : x)));
    } catch {
      setError(`Could not reset ${nameOf(u)}.`);
    } finally {
      setResetting((prev) => {
        const next = new Set(prev);
        next.delete(u.id);
        return next;
      });
    }
  }

  async function resetAll(): Promise<void> {
    setResettingAll(true);
    setError(null);
    setNotice(null);
    try {
      const { count } = await resetCtiEveryone();
      setConfirmAll(false);
      setNotice(`Reset sent to ${count} ${count === 1 ? 'person' : 'people'}.`);
      await load().catch(() => setError('Could not refresh the team.'));
    } catch {
      setError('Could not reset everyone.');
    } finally {
      setResettingAll(false);
    }
  }

  if (error && !users) return <div className="set-list"><div className="set-row"><div className="sub" role="alert">{error}</div></div></div>;
  if (!users) return <div className="set-list"><div className="set-row"><div className="sub">Loading…</div></div></div>;

  return (
    <div className="set-list">
      <div className="set-row">
        <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="name">Reset CTI</div>
          <div className="sub">
            Signs a rep&rsquo;s softphone out and clears its sound settings the next time they&rsquo;re not on a call.
            Their iPhone app stays signed in.
          </div>
        </div>
        <button className="btn ghost" disabled={refreshing} onClick={() => void refresh()}>Refresh</button>
        {!confirmAll && <button className="btn ghost" onClick={() => setConfirmAll(true)}>Reset everyone</button>}
      </div>
      {confirmAll && (
        <div className="set-row" role="group" aria-label="Confirm reset everyone">
          <div className="sub">Reset the softphone of everyone in your org except you?</div>
          <button className="btn danger" disabled={resettingAll} onClick={() => void resetAll()}>Yes, reset everyone</button>
          <button className="btn ghost" disabled={resettingAll} onClick={() => setConfirmAll(false)}>Cancel</button>
        </div>
      )}
      {notice ? <div className="set-row"><div className="sub">{notice}</div></div> : null}
      {error ? <div className="set-row"><div className="sub" role="alert">{error}</div></div> : null}
      {users.map((u) => {
        const status = resetStatusLine(u);
        return (
          <div className="set-row" key={u.id}>
            <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div className="name">{nameOf(u)}</div>
              <div className="sub">
                {u.email}
                {u.isAdmin ? ' · Admin' : ''}
              </div>
              {status && <div className="sub">{status}</div>}
              {/* Includes iPhone-only reps and anyone who signs in fresh: it
                  happens the next time a softphone tab of theirs is open. */}
              {resetPending(u) && <div className="sub">Waiting for them to open the softphone</div>}
            </div>
            <button
              role="switch"
              aria-checked={u.powerDialerEnabled}
              aria-label={`Power Dialer for ${nameOf(u)}`}
              className={`btn ${u.powerDialerEnabled ? 'primary' : 'ghost'}`}
              onClick={() => void toggle(u)}
            >
              {u.powerDialerEnabled ? 'Power Dialer: On' : 'Power Dialer: Off'}
            </button>
            <button
              className="btn ghost"
              aria-label={`Reset CTI for ${nameOf(u)}`}
              disabled={resetting.has(u.id) || resettingAll}
              onClick={() => void resetOne(u)}
            >
              Reset CTI
            </button>
          </div>
        );
      })}
    </div>
  );
}
