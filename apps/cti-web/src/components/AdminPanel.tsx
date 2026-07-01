/**
 * Admin-only number-pool management. Lets an org admin add carrier DIDs and
 * assign each one to a rep — or leave it in the shared reserve pool. The
 * rotation engine only ever dials a number assigned to the calling rep, so
 * this screen is how reps get a dialable pool. Admin-gated server-side
 * (POST/PATCH /admin/outbound-numbers return 403 for non-admins); this UI is
 * only mounted when /auth/me reports isAdmin.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatE164 } from '../format';
import { CloudIcon, PlusIcon, ShieldIcon, UserIcon } from '../icons';

interface NumberRow {
  id: string;
  e164: string;
  label: string | null;
  active: boolean;
  health: 'healthy' | 'warning' | 'degraded' | 'spam_likely' | 'unknown';
  assignedUserId: string | null;
  createdAt: string;
}
interface Rep {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

const RESERVE = '__reserve__';

function repLabel(r: Rep): string {
  return (r.displayName?.trim() || r.email.split('@')[0]) + (r.isAdmin ? ' (admin)' : '');
}

export function AdminPanel(): JSX.Element {
  const [numbers, setNumbers] = useState<NumberRow[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Add-number form
  const [showAdd, setShowAdd] = useState(false);
  const [newE164, setNewE164] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newAssignee, setNewAssignee] = useState<string>(RESERVE);
  const [adding, setAdding] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // DNC compliance mode
  type DncMode = 'registry' | 'external_prescrubbed';
  const [dncMode, setDncMode] = useState<DncMode | null>(null);
  const [dncBusy, setDncBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [n, r, d] = await Promise.all([
        api<{ numbers: NumberRow[] }>('/admin/outbound-numbers'),
        api<{ reps: Rep[] }>('/admin/reps'),
        api<{ mode: DncMode }>('/admin/dnc-mode'),
      ]);
      setNumbers(n.numbers);
      setReps(r.reps);
      setDncMode(d.mode);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const setDnc = useCallback(async (mode: DncMode) => {
    setDncBusy(true);
    setErr(null);
    try {
      await api('/admin/dnc-mode', { method: 'PATCH', body: { mode } });
      setDncMode(mode);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDncBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // One-click: pull the org's owned numbers from Twilio into the pool.
  const importFromTwilio = useCallback(async () => {
    setImporting(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await api<{ found: number; registered: number }>(
        '/admin/outbound-numbers/import-twilio', { method: 'POST' },
      );
      await load();
      setNotice(
        r.registered > 0
          ? `Imported ${r.registered} number${r.registered === 1 ? '' : 's'} from Twilio.`
          : 'No numbers found in Twilio.',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [load]);

  const repName = useCallback(
    (id: string | null): string => {
      if (!id) return 'Reserve pool';
      const r = reps.find((x) => x.id === id);
      return r ? repLabel(r) : 'Unknown rep';
    },
    [reps],
  );

  // Group numbers: each rep, then the reserve pool. Stable, predictable order.
  const groups = useMemo(() => {
    const byAssignee = new Map<string | null, NumberRow[]>();
    for (const n of numbers) {
      const key = n.assignedUserId;
      byAssignee.set(key, [...(byAssignee.get(key) ?? []), n]);
    }
    const repGroups = reps.map((r) => ({
      key: r.id,
      title: repLabel(r),
      icon: 'rep' as const,
      rows: byAssignee.get(r.id) ?? [],
    }));
    const reserve = {
      key: RESERVE,
      title: 'Reserve pool',
      icon: 'reserve' as const,
      rows: byAssignee.get(null) ?? [],
    };
    return [...repGroups, reserve];
  }, [numbers, reps]);

  const patchNumber = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setBusyId(id);
      try {
        const { number } = await api<{ number: NumberRow }>(`/admin/outbound-numbers/${id}`, {
          method: 'PATCH',
          body,
        });
        setNumbers((prev) => prev.map((n) => (n.id === id ? number : n)));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  const assign = useCallback(
    (id: string, value: string) => {
      void patchNumber(id, { assignedUserId: value === RESERVE ? null : value });
    },
    [patchNumber],
  );

  const addNumber = useCallback(async () => {
    setFormErr(null);
    const e164 = newE164.trim();
    if (!e164) { setFormErr('Enter a phone number.'); return; }
    setAdding(true);
    try {
      const { number } = await api<{ number: NumberRow }>('/admin/outbound-numbers', {
        method: 'POST',
        body: {
          e164,
          label: newLabel.trim() || undefined,
          assignedUserId: newAssignee === RESERVE ? null : newAssignee,
        },
      });
      // Upsert into local state (POST is an upsert server-side).
      setNumbers((prev) => {
        const without = prev.filter((n) => n.id !== number.id);
        return [number, ...without];
      });
      setNewE164(''); setNewLabel(''); setNewAssignee(RESERVE); setShowAdd(false);
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setAdding(false);
    }
  }, [newE164, newLabel, newAssignee]);

  if (loading) return <div className="empty-state"><span className="spinner lg" /></div>;

  return (
    <div className="admin">
      <div className="admin-head">
        <div className="admin-title">Number pool <span className="count">{numbers.length}</span></div>
        <div className="admin-head-actions">
          <button className="btn ghost compact" disabled={importing} onClick={() => void importFromTwilio()}>
            {importing ? <><span className="spinner" /> Importing…</> : <><CloudIcon /> Import from Twilio</>}
          </button>
          <button className="btn primary compact" onClick={() => setShowAdd((v) => !v)}>
            <PlusIcon /> Add
          </button>
        </div>
      </div>

      <div className="admin-compliance">
        <div className="admin-group-head"><ShieldIcon /> DNC compliance</div>
        <div className="dnc-modes">
          <button
            type="button"
            className={`dnc-mode ${dncMode === 'registry' ? 'selected' : ''}`}
            disabled={dncBusy || dncMode === null}
            onClick={() => void setDnc('registry')}
          >
            <span className="dnc-mode-title">Check DNC registry</span>
            <span className="dnc-mode-desc">Scrub each number against the loaded DNC list.</span>
          </button>
          <button
            type="button"
            className={`dnc-mode ${dncMode === 'external_prescrubbed' ? 'selected' : ''}`}
            disabled={dncBusy || dncMode === null}
            onClick={() => void setDnc('external_prescrubbed')}
          >
            <span className="dnc-mode-title">Pre-scrubbed lists</span>
            <span className="dnc-mode-desc">Lists scrubbed before loading — gate shows green “pre-scrubbed (org policy)”.</span>
          </button>
        </div>
      </div>

      {notice && <div className="admin-notice">{notice}</div>}

      {showAdd && (
        <div className="admin-add">
          <input
            className="field"
            placeholder="+16195551234"
            value={newE164}
            onChange={(e) => setNewE164(e.target.value)}
            autoFocus
            inputMode="tel"
          />
          <input
            className="field"
            placeholder="Label (optional, e.g. San Diego)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            maxLength={64}
          />
          <select className="field" value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}>
            <option value={RESERVE}>Reserve pool (unassigned)</option>
            {reps.map((r) => (
              <option key={r.id} value={r.id}>Assign to {repLabel(r)}</option>
            ))}
          </select>
          {formErr && <div className="admin-formerr">{formErr}</div>}
          <div className="admin-add-actions">
            <button className="btn ghost compact grow" onClick={() => { setShowAdd(false); setFormErr(null); }}>
              Cancel
            </button>
            <button className="btn primary compact grow" disabled={adding} onClick={() => void addNumber()}>
              {adding ? <span className="spinner" /> : 'Add number'}
            </button>
          </div>
        </div>
      )}

      {err && <div className="admin-err">{err}</div>}

      {numbers.length === 0 && !showAdd ? (
        <div className="empty-state">
          <ShieldIcon className="empty-icon" />
          No numbers yet
          <span className="empty-hint">Add carrier DIDs and assign them to reps. Unassigned numbers stay in the shared reserve pool.</span>
        </div>
      ) : (
        groups.map((g) => (
          <div className="admin-group" key={g.key}>
            <div className="admin-group-head">
              {g.icon === 'rep' ? <UserIcon /> : <ShieldIcon />}
              <span className="g-title">{g.title}</span>
              <span className="count">{g.rows.length}</span>
            </div>
            {g.rows.length === 0 ? (
              <div className="admin-group-empty">None</div>
            ) : (
              g.rows.map((n) => (
                <div className={`admin-num ${n.active ? '' : 'inactive'}`} key={n.id}>
                  <div className="num-main">
                    <span className="num-e164">{formatE164(n.e164)}</span>
                    {n.label && <span className="num-label">{n.label}</span>}
                  </div>
                  <span className={`health-dot health-${n.health}`} title={`Health: ${n.health.replace('_', ' ')}`} />
                  <select
                    className="field num-assign"
                    value={n.assignedUserId ?? RESERVE}
                    disabled={busyId === n.id}
                    onChange={(e) => assign(n.id, e.target.value)}
                  >
                    <option value={RESERVE}>Reserve</option>
                    {reps.map((r) => (
                      <option key={r.id} value={r.id}>{repLabel(r)}</option>
                    ))}
                  </select>
                  <button
                    className={`btn compact ${n.active ? 'ghost' : 'primary'}`}
                    disabled={busyId === n.id}
                    title={n.active ? 'Pause (stop dialing from this DID)' : 'Activate'}
                    onClick={() => void patchNumber(n.id, { active: !n.active })}
                  >
                    {n.active ? 'Pause' : 'Activate'}
                  </button>
                </div>
              ))
            )}
          </div>
        ))
      )}
    </div>
  );
}
