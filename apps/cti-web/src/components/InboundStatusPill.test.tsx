import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { inboundPillState, InboundStatusPill } from './InboundStatusPill';

describe('inboundPillState', () => {
  it('leader + registered + healthy = on', () => {
    expect(inboundPillState({ isLeader: true, registered: true, degraded: false })).toBe('on');
  });
  it('non-leader = elsewhere (another tab owns inbound)', () => {
    expect(inboundPillState({ isLeader: false, registered: false, degraded: false })).toBe('elsewhere');
  });
  it('leader but not yet registered, or degraded = reconnecting', () => {
    expect(inboundPillState({ isLeader: true, registered: false, degraded: false })).toBe('reconnecting');
    expect(inboundPillState({ isLeader: true, registered: true, degraded: true })).toBe('reconnecting');
  });
});

describe('InboundStatusPill', () => {
  it('shows a Use-here affordance only in the elsewhere state', () => {
    expect(renderToStaticMarkup(<InboundStatusPill state="elsewhere" onUseHere={() => {}} />)).toContain('Use here');
    expect(renderToStaticMarkup(<InboundStatusPill state="on" onUseHere={() => {}} />)).not.toContain('Use here');
  });
  it('labels each state for the rep', () => {
    expect(renderToStaticMarkup(<InboundStatusPill state="on" onUseHere={() => {}} />)).toContain('Inbound on');
    expect(renderToStaticMarkup(<InboundStatusPill state="reconnecting" onUseHere={() => {}} />)).toContain('Reconnecting');
    expect(renderToStaticMarkup(<InboundStatusPill state="elsewhere" onUseHere={() => {}} />)).toContain('another tab');
  });
});
