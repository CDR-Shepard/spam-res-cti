import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunSettingsBlock } from './RunSettingsBlock';
import type { RunDraft } from '../run-settings';

const noop = (): void => {};
const html = (draft: RunDraft, busy = false): string =>
  renderToStaticMarkup(<RunSettingsBlock draft={draft} listSize={202} busy={busy} onChange={noop} />);
const today: RunDraft = { passes: 2, rolloverBusinessDays: 1, howMany: '' };

describe('RunSettingsBlock (SSR)', () => {
  it("shows the three settings with today's run pressed and the box blank (All) of the list size", () => {
    const out = html(today);
    expect(out).toContain('Calls per person');
    expect(out).toContain('How many');
    expect(out).toContain('Missed tasks move to');
    expect(out).toMatch(/aria-pressed="true">Twice<\/button>/);
    expect(out).toMatch(/aria-pressed="false">Once<\/button>/);
    expect(out).toMatch(/aria-pressed="true">Next business day<\/button>/);
    expect(out).toMatch(/aria-pressed="false">In 2 business days<\/button>/);
    expect(out).toContain('placeholder="All"');
    expect(out).toContain('<span>Call the first</span>');
    expect(out).toContain('<span>of 202</span>');
    expect(out).not.toContain('Enter a whole number');
  });

  it('reflects Once, a number, and In 2 business days', () => {
    const out = html({ passes: 1, rolloverBusinessDays: 2, howMany: '100' });
    expect(out).toMatch(/aria-pressed="true">Once<\/button>/);
    expect(out).toMatch(/aria-pressed="true">In 2 business days<\/button>/);
    expect(out).toContain('value="100"');
  });

  it('says why an out-of-range number cannot start', () => {
    const out = html({ ...today, howMany: '203' });
    expect(out).toContain('Enter a whole number from 1 to 202, or leave it blank for all.');
    expect(out).toContain('aria-invalid="true"');
  });

  it('locks every choice while a Start is in flight (four buttons and the box)', () => {
    expect((html(today, true).match(/disabled=""/g) ?? []).length).toBe(5);
  });
});
