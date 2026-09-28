/**
 * The three run settings on Ready to dial (spec
 * docs/superpowers/specs/2026-09-28-run-settings-design.md): Calls per person,
 * How many, Missed tasks move to. Prop-only — DialerPanel owns the draft — so
 * it renders under renderToStaticMarkup like ConfirmBlock.
 */
import { useId } from 'react';
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
  // Accessibility fix (Minor 4, spec 2026-09-28 review): useId, not a fixed
  // string, so these ids stay unique if this block is ever mounted twice on
  // one page (two dialer tabs, say) — a collision would make aria-labelledby/
  // aria-describedby point a screen reader at the WRONG block's text.
  const passesLabelId = useId();
  const rolloverLabelId = useId();
  const howManyInputId = useId();
  const howManyErrorId = useId();
  return (
    <div className="dp-run-settings-block">
      <div className="dp-setting">
        <div className="dp-setting-label" id={passesLabelId}>Calls per person</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby={passesLabelId}>
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
        <label className="dp-setting-label" htmlFor={howManyInputId}>How many</label>
        <div className="row dp-setting-howmany">
          <span>Call the first</span>
          <input
            id={howManyInputId}
            className="dp-how-many-input"
            type="text"
            inputMode="numeric"
            placeholder="All"
            value={draft.howMany}
            disabled={busy}
            aria-invalid={!howMany.ok}
            aria-describedby={howMany.ok ? undefined : howManyErrorId}
            onChange={(e) => onChange({ ...draft, howMany: digitsOnly(e.target.value) })}
          />
          <span>{`of ${listSize}`}</span>
        </div>
        {!howMany.ok && <div className="dp-error" id={howManyErrorId} role="alert">{howMany.error}</div>}
      </div>
      <div className="dp-setting">
        <div className="dp-setting-label" id={rolloverLabelId}>Missed tasks move to</div>
        <div className="row dp-setting-choices" role="group" aria-labelledby={rolloverLabelId}>
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
