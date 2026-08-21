/**
 * Pure timing plans for browser actions.  The executor decides how to turn
 * these plans into browser events, so this module stays DOM- and API-free.
 */
const DEFAULT_RNG = Math.random;

function between(rng, min, max) {
  return min + rng() * (max - min);
}

export function bezierPath(fromX, fromY, toX, toY, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  const steps = opts.steps ?? Math.floor(between(rng, 25, 45));
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy) || 1;
  const perpendicularOffset = (rng() - 0.5) * distance * 0.6;
  const controlX = (fromX + toX) / 2 + (-dy / distance) * perpendicularOffset;
  const controlY = (fromY + toY) / 2 + (dx / distance) * perpendicularOffset;

  return Array.from({ length: steps }, (_, offset) => {
    const t = (offset + 1) / steps;
    return {
      x: (1 - t) ** 2 * fromX + 2 * (1 - t) * t * controlX + t ** 2 * toX,
      y: (1 - t) ** 2 * fromY + 2 * (1 - t) * t * controlY + t ** 2 * toY,
    };
  });
}

export function movePlan(fromX, fromY, toX, toY, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return bezierPath(fromX, fromY, toX, toY, opts).map((point) => ({
    ...point,
    delayMs: Math.round(between(rng, 10, 30)),
  }));
}

export function clickPoint(box, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return {
    x: box.x + box.width * between(rng, 0.3, 0.7),
    y: box.y + box.height * between(rng, 0.3, 0.7),
  };
}

export function typingPlan(text, opts = {}) {
  const rng = opts.rng ?? DEFAULT_RNG;
  return Array.from(text).map((char) => {
    let delayMs = between(rng, 60, 180);
    if (rng() < 0.08) delayMs += between(rng, 200, 500);
    return { char, delayMs: Math.round(delayMs) };
  });
}
