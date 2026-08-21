import { clickPoint, movePlan, typingPlan } from './human.js';

async function pace(delayMs, fast) {
  if (!fast) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function nativeSetValue(el, value) {
  const proto = el instanceof globalThis.HTMLTextAreaElement
    ? globalThis.HTMLTextAreaElement.prototype
    : globalThis.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fireMouse(el, type, point) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
}

export const syntheticImpl = {
  async click(el, opts = {}) {
    const { rng, fast = false } = opts;
    el.scrollIntoView?.({ block: 'center' });
    await pace(400, fast);
    const box = el.getBoundingClientRect();
    const point = clickPoint(box, { rng });
    for (const step of movePlan(box.x, box.y, point.x, point.y, { rng, steps: fast ? 2 : undefined })) {
      fireMouse(el, 'mousemove', step);
      await pace(step.delayMs, fast);
    }
    fireMouse(el, 'mousedown', point);
    await pace(80, fast);
    fireMouse(el, 'mouseup', point);
    fireMouse(el, 'click', point);
  },

  async type(el, text, opts = {}) {
    const { rng, fast = false } = opts;
    el.focus?.();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    nativeSetValue(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    for (const step of typingPlan(text, { rng })) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: step.char, bubbles: true }));
      nativeSetValue(el, el.value + step.char);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: step.char, bubbles: true }));
      await pace(step.delayMs, fast);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  async scroll(dy, opts = {}) {
    const win = opts.win ?? globalThis.window;
    for (let i = 0; i < 4; i += 1) {
      win.scrollBy(0, dy / 4);
      await pace(250, opts.fast === true);
    }
  },

  async navigate(url, opts = {}) {
    (opts.win ?? globalThis.window).location.href = url;
  },
};
