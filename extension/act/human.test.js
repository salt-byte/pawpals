import { describe, expect, it } from 'vitest';
import { bezierPath, clickPoint, movePlan, typingPlan } from './human.js';

const half = () => 0.5;

describe('human action plans', () => {
  it('produces a curved path that ends at the target', () => {
    const path = bezierPath(0, 0, 100, 50, { rng: half, steps: 10 });
    expect(path).toHaveLength(10);
    expect(path.at(-1)).toMatchObject({ x: 100, y: 50 });
    expect(bezierPath(0, 0, 100, 0, { rng: () => 0.9, steps: 11 })[4].y).not.toBe(0);
  });

  it('adds bounded movement delays', () => {
    for (const step of movePlan(0, 0, 100, 100, { rng: half, steps: 5 })) {
      expect(step.delayMs).toBeGreaterThanOrEqual(10);
      expect(step.delayMs).toBeLessThanOrEqual(30);
    }
  });

  it('selects an interior click point', () => {
    expect(clickPoint({ x: 0, y: 0, width: 100, height: 40 }, { rng: half })).toEqual({ x: 50, y: 20 });
  });

  it('keeps typed characters in order and can add thinking pauses', () => {
    expect(typingPlan('你好ab', { rng: half }).map((step) => step.char).join('')).toBe('你好ab');
    const total = (plan) => plan.reduce((sum, step) => sum + step.delayMs, 0);
    expect(total(typingPlan('abcdefghij', { rng: () => 0.01 })))
      .toBeGreaterThan(total(typingPlan('abcdefghij', { rng: half })));
  });
});
