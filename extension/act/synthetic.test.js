import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeSetValue, syntheticImpl } from './synthetic.js';

function button() {
  const el = document.body.appendChild(document.createElement('button'));
  el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('synthetic implementation', () => {
  it('uses normal value setters for inputs and textareas', () => {
    const input = document.body.appendChild(document.createElement('input'));
    const textarea = document.body.appendChild(document.createElement('textarea'));
    nativeSetValue(input, '产品经理'); nativeSetValue(textarea, '你好');
    expect(input.value).toBe('产品经理'); expect(textarea.value).toBe('你好');
  });

  it('dispatches a full click sequence as untrusted DOM events', async () => {
    const el = button(); const seen = [];
    for (const type of ['mousedown', 'mouseup', 'click']) el.addEventListener(type, (event) => seen.push([type, event.isTrusted]));
    await syntheticImpl.click(el, { rng: () => 0.5, fast: true });
    expect(seen).toEqual([['mousedown', false], ['mouseup', false], ['click', false]]);
  });

  it('clears then types character-by-character and segments scrolling', async () => {
    const input = document.body.appendChild(document.createElement('input')); input.value = '旧内容';
    const onInput = vi.fn(); input.addEventListener('input', onInput);
    await syntheticImpl.type(input, 'abc', { rng: () => 0.5, fast: true });
    expect(input.value).toBe('abc'); expect(onInput).toHaveBeenCalledTimes(4);
    const scrollBy = vi.fn(); await syntheticImpl.scroll(300, { win: { scrollBy }, fast: true });
    expect(scrollBy).toHaveBeenCalledTimes(4);
  });
});
