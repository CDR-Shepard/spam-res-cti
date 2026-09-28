/**
 * The three run settings on Ready to dial (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md): Calls per person,
 * How many, Missed tasks move to. Prop-only — DialerPanel owns the draft — so
 * it renders under renderToStaticMarkup like ConfirmBlock.
 */
import { DIALER_PASSES, ROLLOVER_BUSINESS_DAYS } from '@cti/contracts';
import { digitsOnly, parseHowMany, PASS_LABELS, ROLLOVER_LABELS, type RunDraft } from '../run-settings';

export interface RunSettingsBlockProps {
  draft: RunDraft;
  /** The run's list size — the box's upper bound and its "of N". */
  listSize: number;
  /** A Start is in flight: nothing here may change under it. */
  busy: boolean;
  onChange: (draft: RunDraft) => void;
}

export function RunSettingsBlock({ draft, listSize, busy, onChange }: RunSettingsBlockProps): JSX.Element {
  const howMany = parseHowMany(draft.howMany);
  return (
    <div className="dp-run-settings-block">
      <div className="dp-setting">
        <div className="dp-setting-label" id="dp-passes-label">Calls per person</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby="dp-passes-label">
          {DIALER_PASSES.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn ${draft.passes === value ? 'active' : ''}`}
              aria-pressed={draft.passes === value}
              disabled={busy}
              onClick={() => onChange({ ...draft, passes: value })}
            >
              {PASS_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div className="dp-setting">
        <label className="dp-setting-label" htmlFor="dp-how-many">How many</label>
        <div className="row dp-setting-howmany">
          <span>Call the first</span>
          <input
            id="dp-how-many"
            className="dp-how-many-input"
            type="text"
            inputMode="numeric"
            placeholder="All"
            value={draft.howMany}
            disabled={busy}
            aria-invalid={!howMany.ok}
            onChange={(e) => onChange({ ...draft, howMany: digitsOnly(e.target.value) })}
          />
          <span>{`of ${listSize}`}</span>
        </div>
        {!howMany.ok && <div className="dp-error">{howMany.error}</div>}
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label" id="dp-rollover-label">Missed tasks move to</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby="dp-rollover-label">
          {ROLLOVER_BUSINESS_DAYS.map((value) => (
            <button
              key={value}
              type="button"
              className={`btn ${draft.rolloverBusinessDays === value ? 'active' : ''}`}
              aria-pressed={draft.rolloverBusinessDays === value}
              disabled={busy}
              onClick={() => onChange({ ...draft, rolloverBusinessDays: value })}
            >
              {ROLLOVER_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
