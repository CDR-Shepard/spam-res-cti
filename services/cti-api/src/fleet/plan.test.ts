import { describe, expect, it } from 'vitest';
import { buyPlanForRep, classifyArea, poolBuyCount, poolBuyTarget, reserveBuyTarget } from './plan.js';

describe('classifyArea', () => {
  it('maps LA (213/323), SD (619/858), everything else other', () => {
    expect(classifyArea('+12137744220')).toBe('LA');
    expect(classifyArea('+13235249247')).toBe('LA');
    expect(classifyArea('+16193507799')).toBe('SD');
    expect(classifyArea('+18584221927')).toBe('SD');
    expect(classifyArea('+12054303297')).toBe('other'); // owned test DID
    expect(classifyArea('+18665896850')).toBe('other'); // toll-free
  });
});

const h = (e164: string, health = 'unknown', active = true) => ({ e164, health, active });

describe('buyPlanForRep — the four real reps', () => {
  it('Evren: 5 SD held → buy 6 LA + 1 SD', () => {
    expect(buyPlanForRep([h('+16193507799'), h('+16193693324'), h('+16198153354'), h('+16198536881'), h('+18587589687')])).toEqual({ la: 6, sd: 1 });
  });
  it('Matt: degraded 213 does NOT count → buy 4 LA + 3 SD', () => {
    expect(buyPlanForRep([h('+12137544220'), h('+12137742225', 'degraded'), h('+13235249247'), h('+16198481782'), h('+16198486573'), h('+18583585449')])).toEqual({ la: 4, sd: 3 });
  });
  it('Tyler: 3/3 held → 3 LA + 3 SD; Jona: nothing → 6 + 6', () => {
    expect(buyPlanForRep([h('+12137147277'), h('+12137151307'), h('+12137290113'), h('+16195378265'), h('+16198641417'), h('+18584221927')])).toEqual({ la: 3, sd: 3 });
    expect(buyPlanForRep([])).toEqual({ la: 6, sd: 6 });
  });
  it('overshoot clamps to zero and inactive/other never count', () => {
    const seven = ['+12131110001', '+12131110002', '+12131110003', '+13231110004', '+12131110005', '+13231110006', '+12131110007'].map((e) => h(e));
    expect(buyPlanForRep([...seven, h('+16191110008'), h('+12054303297')]).la).toBe(0);
    expect(buyPlanForRep([h('+12137544220', 'unknown', false)]).la).toBe(6);
  });
});

describe('poolBuyCount', () => {
  it('50-target minus existing, floored at 0', () => {
    expect(poolBuyCount(10)).toBe(40);
    expect(poolBuyCount(55)).toBe(0);
  });
});

describe('poolBuyTarget — --count is a target, never an increment', () => {
  it('first run: 10 live, empty hand-off, asked 40 → buys 40', () => {
    expect(poolBuyTarget(40, 10, 0)).toBe(40);
  });
  it('mid-run resume: 40 already bought into the hand-off → buys 0 more', () => {
    expect(poolBuyTarget(40, 10, 40)).toBe(0);
    expect(poolBuyTarget(40, 10, 12)).toBe(28);
  });
  it('AFTER register (hand-off pruned, DB now holds them) a re-run buys nothing', () => {
    expect(poolBuyTarget(40, 50, 0)).toBe(0);
    expect(poolBuyTarget(40, 45, 0)).toBe(5); // only the remaining shortfall toward 50
  });
  it('never buys past the 50 target even when asked for more, and never negative', () => {
    expect(poolBuyTarget(100, 10, 0)).toBe(40);
    expect(poolBuyTarget(40, 60, 0)).toBe(0);
    expect(poolBuyTarget(5, 10, 9)).toBe(0);
  });
});

describe('reserveBuyTarget — --la/--sd are inventory targets', () => {
  it('first run: nothing free, empty hand-off → buys the whole target', () => {
    expect(reserveBuyTarget(60, 0, 0)).toBe(60);
  });
  it('subtracts free reserve already in the DB and unregistered hand-off entries', () => {
    expect(reserveBuyTarget(60, 12, 0)).toBe(48);
    expect(reserveBuyTarget(60, 12, 8)).toBe(40);
  });
  it('AFTER register the same command buys 0 — no double-spend', () => {
    expect(reserveBuyTarget(60, 60, 0)).toBe(0);
    expect(reserveBuyTarget(60, 70, 0)).toBe(0); // over target clamps, never negative
  });
});
