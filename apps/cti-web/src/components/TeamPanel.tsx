import { useEffect, useState } from 'react';
import { listTeam, setPowerDialer, type TeamUser } from '../team-api';

/** Admin-only Team panel: grant/revoke Power Dialer per user. The server gate
 *  (403 power_dialer_disabled) is authoritative and instant; the rep's own tab
 *  bar updates on their next /auth/me refresh. */
export function TeamPanel(): JSX.Element {
  const [users, setUsers] = useState<TeamUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listTeam().then((r) => setUsers(r.users)).catch(() => setError('Could not load the team.'));
  }, []);

  async function toggle(u: TeamUser): Promise<void> {
    const next = !u.powerDialerEnabled;
    setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: next } : x)));
    try {
      await setPowerDialer(u.id, next);
    } catch {
      setUsers((prev) => prev!.map((x) => (x.id === u.id ? { ...x, powerDialerEnabled: u.powerDialerEnabled } : x)));
      setError(`Could not update ${u.displayName ?? u.email}.`);
    }
  }

  if (error && !users) return <div className="set-list"><div className="set-row"><div className="sub">{error}</div></div></div>;
  if (!users) return <div className="set-list"><div className="set-row"><div className="sub">Loading…</div></div></div>;

  return (
    <div className="set-list">
      {error ? <div className="set-row"><div className="sub">{error}</div></div> : null}
      {users.map((u) => (
        <div className="set-row" key={u.id}>
          <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div className="name">{u.displayName ?? u.email}</div>
            <div className="sub">
              {u.email}
              {u.isAdmin ? ' · Admin' : ''}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={u.powerDialerEnabled}
            aria-label={`Power Dialer for ${u.displayName ?? u.email}`}
            className={`btn ${u.powerDialerEnabled ? 'primary' : 'ghost'}`}
            onClick={() => void toggle(u)}
          >
            {u.powerDialerEnabled ? 'Power Dialer: On' : 'Power Dialer: Off'}
          </button>
        </div>
      ))}
    </div>
  );
}
