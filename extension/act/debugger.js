import { clickPoint, movePlan, typingPlan } from './human.js';

async function pace(delayMs, fast) {
  if (!fast) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Build a Chrome DevTools Protocol executor around an injected sender.
 * Keeping chrome.debugger outside this module makes command construction testable.
 */
export function createDebuggerImpl(sendCommand, opts = {}) {
  const { fast = false, rng } = opts;
  const mouse = (type, x, y, extra = {}) => sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
  return {
    async click(el) {
      el.scrollIntoView?.({ block: 'center' });
      await pace(400, fast);
      const box = el.getBoundingClientRect();
      const point = clickPoint(box, { rng });
      for (const step of movePlan(box.x, box.y, point.x, point.y, { rng, steps: fast ? 2 : undefined })) {
        await mouse('mouseMoved', step.x, step.y);
        await pace(step.delayMs, fast);
      }
      await mouse('mousePressed', point.x, point.y, { button: 'left', clickCount: 1 });
      await pace(80, fast);
      await mouse('mouseReleased', point.x, point.y, { button: 'left', clickCount: 1 });
    },

    async type(el, text) {
      const box = el.getBoundingClientRect();
      const point = clickPoint(box, { rng });
      await mouse('mousePressed', point.x, point.y, { button: 'left', clickCount: 1 });
      await mouse('mouseReleased', point.x, point.y, { button: 'left', clickCount: 1 });
      for (const step of typingPlan(text, { rng })) {
        await sendCommand('Input.insertText', { text: step.char });
        await pace(step.delayMs, fast);
      }
    },

    async scroll(dy) {
      for (let i = 0; i < 4; i += 1) {
        await mouse('mouseWheel', 400, 400, { deltaX: 0, deltaY: dy / 4 });
        await pace(250, fast);
      }
    },

    async navigate(url) {
      await sendCommand('Page.navigate', { url });
    },
  };
}
