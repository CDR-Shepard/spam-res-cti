/**
 * Reputation dashboard — per-DID caller reputation as a Hiya-style credit
 * score (Maturity / Connection / Engagement / Sentiment; composite = weakest
 * axis). Identical component in cti-web and cti-desktop.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatE164 } from '../format';
import { ChevronDown, ShieldIcon } from '../icons';

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

interface AxisScore { value: number; grade: Grade; detail: string }

interface NumberReputation {
  numberId: string;
  e164: string;
  label: string | null;
  health: string;
  shakenAttestationDistribution: Record<'A' | 'B' | 'C' | 'unknown', number>;
  daysSinceFirstUse: number | null;
  warmupTier: number;
  warmupCap: number;
  dialsToday: number;
  dialsLast7d: number;
  avgDurationLast7dSec: number | null;
  answerRate: number;
  sub6sRate: number;
  attestationABRate: number;
  axes: { maturity: AxisScore; connection: AxisScore; engagement: AxisScore; sentiment: AxisScore };
  composite: { value: number; grade: Grade };
}

interface ReputationResponse {
  summary: {
    numberCount: number;
    flaggedCount: number;
    avgComposite: number;
    avgGrade: Grade;
    dialsTodayUsed: number;
    dialsTodayCapacity: number;
    dialsTodayUtilization: number;
  };
  numbers: NumberReputation[];
}

const AXES: Array<{ key: keyof NumberReputation['axes']; label: string }> = [
  { key: 'maturity', label: 'Maturity' },
  { key: 'connection', label: 'Connection' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'sentiment', label: 'Sentiment' },
];

function gradeClass(g: Grade): string {
  return `grade-${g.toLowerCase()}`;
}

function ScoreRing({ value, grade }: { value: number; grade: Grade }): JSX.Element {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${gradeClass(grade)}`} viewBox="0 0 64 64" role="img" aria-label={`Score ${value}, grade ${grade}`}>
      <circle className="track" cx="32" cy="32" r={r} />
      <circle
        className="meter"
        cx="32"
        cy="32"
        r={r}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, value)) / 100)}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="33" className="ring-grade">{grade}</text>
    </svg>
  );
}

function AxisBar({ label, axis }: { label: string; axis: AxisScore }): JSX.Element {
  return (
    <div className="axis">
      <div className="axis-head">
        <span className="axis-name">{label}</span>
        <span className={`axis-score ${gradeClass(axis.grade)}`}>{axis.value}</span>
      </div>
      <div className="meterbar">
        <div className={`meterfill ${gradeClass(axis.grade)}`} style={{ width: `${axis.value}%` }} />
      </div>
      <div className="axis-detail">{axis.detail}</div>
    </div>
  );
}

function AttestationStrip({ dist, total }: { dist: Record<string, number>; total: number }): JSX.Element {
  if (total === 0) return <div className="axis-detail">No calls in the last 7 days</div>;
  const segs: Array<{ k: string; v: number; cls: string }> = [
    { k: 'A', v: dist.A ?? 0, cls: 'ok' },
    { k: 'B', v: dist.B ?? 0, cls: 'warn' },
    { k: 'C', v: dist.C ?? 0, cls: 'bad' },
    { k: '·', v: dist.unknown ?? 0, cls: 'dim' },
  ];
  return (
    <div>
      <div className="att-strip">
        {segs.map((s) => s.v > 0 && (
          <div key={s.k} className={s.cls} style={{ width: `${(s.v / total) * 100}%` }} />
        ))}
      </div>
      <div className="att-legend">
        {segs.map((s) => (
          <span key={s.k}><i className={`cdot ${s.cls}`} />{s.k === '·' ? 'n/a' : s.k} {s.v}</span>
        ))}
      </div>
    </div>
  );
}

function healthCopy(n: NumberReputation): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (n.health === 'spam_likely') return { text: 'Flagged “Spam Likely”', tone: 'bad' };
  if (n.health === 'degraded') return { text: 'Degraded — resting', tone: 'warn' };
  return { text: 'Healthy', tone: 'ok' };
}

function NumberCard({ n }: { n: NumberReputation }): JSX.Element {
  const [open, setOpen] = useState(false);
  const warmupPct = n.warmupCap > 0 ? Math.min(100, (n.dialsToday / n.warmupCap) * 100) : 0;
  const health = healthCopy(n);
  return (
    <div className={`repcard ${open ? 'open' : ''}`}>
      <button className="repcard-head" onClick={() => setOpen((v) => !v)}>
        <span className={`grade-chip ${gradeClass(n.composite.grade)}`}>{n.composite.grade}</span>
        <span className="repcard-id">
          <span className="repcard-num">{formatE164(n.e164)}</span>
          <span className="repcard-meta">
            {n.label ? `${n.label} · ` : ''}
            <i className={`cdot ${health.tone}`} />{health.text}
            {n.daysSinceFirstUse != null ? ` · day ${n.daysSinceFirstUse + 1}` : ' · new'}
          </span>
        </span>
        <span className="repcard-score">
          <span className={`score ${gradeClass(n.composite.grade)}`}>{n.composite.value}</span>
          <ChevronDown className="chev" />
        </span>
      </button>
      <div className="repcard-warmup">
        <div className="meterbar">
          <div
            className={`meterfill ${warmupPct >= 100 ? 'grade-f' : warmupPct >= 80 ? 'grade-c' : 'grade-a'}`}
            style={{ width: `${warmupPct}%` }}
          />
        </div>
        <span className="repcard-warmup-label">{n.dialsToday}/{n.warmupCap} dials today · warmup tier {n.warmupTier}</span>
      </div>
      {open && (
        <div className="repcard-body">
          {AXES.map((a) => <AxisBar key={a.key} label={a.label} axis={n.axes[a.key]} />)}
          <div className="repcard-section">STIR/SHAKEN · last 7 days</div>
          <AttestationStrip dist={n.shakenAttestationDistribution} total={n.dialsLast7d} />
          <div className="repcard-stats">
            <span>{n.dialsLast7d} calls / 7d</span>
            <span>{Math.round(n.answerRate * 100)}% answered</span>
            <span>{n.avgDurationLast7dSec != null ? `${Math.round(n.avgDurationLast7dSec)}s avg` : 'no talk time'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ReputationPanel(): JSX.Element {
  const [data, setData] = useState<ReputationResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<ReputationResponse>('/reputation'));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (err && !data) return <div className="empty-state bad">{err}</div>;
  if (!data) return <div className="empty-state"><span className="spinner lg" /></div>;

  const { summary, numbers } = data;
  const utilPct = Math.round(summary.dialsTodayUtilization * 100);

  return (
    <div className="rep">
      <div className="rep-hero">
        <ScoreRing value={summary.avgComposite} grade={summary.avgGrade} />
        <div className="rep-hero-text">
          <div className="kicker">Caller reputation</div>
          <div className="rep-hero-score">
            <span className={gradeClass(summary.avgGrade)}>{summary.avgComposite}</span>
            <span className="rep-hero-outof">/ 100</span>
          </div>
          <div className="rep-hero-meta">
            {summary.numberCount} {summary.numberCount === 1 ? 'number' : 'numbers'}
            {summary.flaggedCount > 0 && <span className="flag-chip">{summary.flaggedCount} flagged</span>}
          </div>
        </div>
      </div>

      <div className="rep-cap">
        <div className="rep-cap-head">
          <span className="kicker">Safe dial capacity today</span>
          <span className="rep-cap-nums">{summary.dialsTodayUsed}<em> / {summary.dialsTodayCapacity}</em></span>
        </div>
        <div className="meterbar tall">
          <div
            className={`meterfill ${utilPct > 90 ? 'grade-f' : utilPct > 70 ? 'grade-c' : 'grade-a'}`}
            style={{ width: `${Math.min(100, utilPct)}%` }}
          />
        </div>
        <div className="rep-cap-note">{utilPct}% of the warmup-safe daily cap across your pool</div>
      </div>

      <div className="kicker rep-list-title">Numbers</div>
      {numbers.length === 0 ? (
        <div className="empty-state">
          <ShieldIcon className="empty-icon" />
          No outbound numbers yet.
          <span className="empty-hint">Add a verified caller ID in Settings to start tracking its reputation.</span>
        </div>
      ) : (
        numbers.map((n) => <NumberCard key={n.numberId} n={n} />)
      )}

      <div className="footnote">
        Modeled on Hiya’s Caller Reputation score — Maturity · Connection · Engagement · Sentiment.
        Composite = weakest axis, mirroring carrier-grade algorithms.
      </div>
    </div>
  );
}
