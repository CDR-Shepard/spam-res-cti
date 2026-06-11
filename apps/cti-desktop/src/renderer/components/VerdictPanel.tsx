/**
 * Firewall verdict panel — turns the raw 19-gate response into a decision
 * the rep can read at a glance: a tinted banner with the call/no-call answer,
 * a pass strip, and the gates grouped by what they protect (reputation →
 * delivery → compliance). Anything that needs attention is always visible;
 * the clean gates collapse behind one toggle.
 */
import { useMemo, useState } from 'react';
import { CATEGORY_LABEL, CATEGORY_ORDER, checkMeta } from '../checks';
import { ChevronDown, ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from '../icons';

export interface FirewallCheck {
  name: string;
  passed: boolean;
  severity: 'block' | 'review' | 'info';
  reasonCode: string;
  detail?: string;
}

export interface FirewallVerdict {
  decision: 'ALLOW' | 'BLOCK' | 'REQUIRE_REVIEW';
  reasons: string[];
  blockReason: string | null;
  requiredScriptId: string | null;
  auditId: string;
  checks: FirewallCheck[];
  normalizedTo: string | null;
  fromNumber: string | null;
}

type Tone = 'ok' | 'warn' | 'bad';

function toneOf(c: FirewallCheck): Tone {
  if (!c.passed && c.severity === 'block') return 'bad';
  if (c.severity === 'review') return 'warn';
  return 'ok';
}

function CheckRow({ check }: { check: FirewallCheck }): JSX.Element {
  const meta = checkMeta(check.name);
  const tone = toneOf(check);
  return (
    <div className={`check ${tone}`} title={meta.hint || undefined}>
      <span className={`cdot ${tone}`} />
      <span className="name">{meta.label}</span>
      {check.detail && <span className="detail">{check.detail}</span>}
    </div>
  );
}

interface VerdictPanelProps {
  verdict: FirewallVerdict;
  busy: boolean;
  onCancel: () => void;
  onCall: () => void;
}

export function VerdictPanel({ verdict, busy, onCancel, onCall }: VerdictPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const { decision, checks } = verdict;
  const tone: Tone = decision === 'ALLOW' ? 'ok' : decision === 'BLOCK' ? 'bad' : 'warn';
  const passedCount = checks.filter((c) => c.passed).length;
  const attention = useMemo(() => checks.filter((c) => toneOf(c) !== 'ok'), [checks]);

  const grouped = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({
        cat,
        items: checks
          .filter((c) => checkMeta(c.name).category === cat)
          .sort((a, b) => (toneOf(a) === 'ok' ? 1 : 0) - (toneOf(b) === 'ok' ? 1 : 0)),
      })).filter((g) => g.items.length > 0),
    [checks],
  );

  const headline =
    decision === 'ALLOW' ? 'Clear to call'
    : decision === 'BLOCK' ? 'Call blocked'
    : 'Review before calling';
  const subline =
    decision === 'ALLOW'
      ? `All ${checks.length} reputation & compliance gates passed`
      : decision === 'BLOCK'
        ? verdict.blockReason ?? 'A blocking gate failed'
        : `${attention.length} ${attention.length === 1 ? 'item needs' : 'items need'} your judgment — see below`;
  const Icon = decision === 'ALLOW' ? ShieldCheckIcon : decision === 'BLOCK' ? ShieldXIcon : ShieldAlertIcon;

  return (
    <div className={`verdict ${tone}`}>
      <div className={`vbanner ${tone}`}>
        <Icon className="vicon" />
        <div className="vtext">
          <div className="vheadline">{headline}</div>
          <div className="vsubline">{subline}</div>
        </div>
      </div>

      <div className="vstrip-row">
        <div className="vstrip">
          {checks.map((c, i) => <span key={i} className={toneOf(c)} />)}
        </div>
        <span className="vcount">{passedCount}/{checks.length}</span>
      </div>

      {expanded ? (
        <div className="checkgroups">
          {grouped.map(({ cat, items }) => (
            <div className="checkgroup" key={cat}>
              <div className="checkgroup-title">{CATEGORY_LABEL[cat]}</div>
              {items.map((c) => <CheckRow key={c.name + c.reasonCode} check={c} />)}
            </div>
          ))}
        </div>
      ) : attention.length > 0 ? (
        <div className="checkgroups">
          <div className="checkgroup">
            {attention.map((c) => <CheckRow key={c.name + c.reasonCode} check={c} />)}
          </div>
        </div>
      ) : null}

      <button className={`expand-toggle ${expanded ? 'open' : ''}`} onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Hide details' : `All ${checks.length} gates`}
        <ChevronDown />
      </button>

      {decision !== 'BLOCK' ? (
        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onCall} disabled={busy}>
            {busy
              ? <><span className="spinner" /> Placing…</>
              : decision === 'REQUIRE_REVIEW' ? 'Acknowledge & call' : 'Call now'}
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Clear</button>
        </div>
      )}
    </div>
  );
}
