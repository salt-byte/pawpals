import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebuggerImpl } from './debugger.js';

function makeEl(box = { x: 10, y: 20, width: 100, height: 40 }) {
  const el = document.body.appendChild(document.createElement('button'));
  el.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height });
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('CDP debugger implementation', () => {
  it('dispatches a proper left mouse click inside the target', async () => {
    const send = vi.fn().mockResolvedValue({});
    await createDebuggerImpl(send, { fast: true, rng: () => 0.5 }).click(makeEl());
    const calls = send.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params);
    const pressed = calls.find(({ type }) => type === 'mousePressed');
    expect(calls.map(({ type }) => type)).toContain('mouseReleased');
    expect(pressed).toMatchObject({ button: 'left', clickCount: 1 });
    expect(pressed.x).toBeGreaterThanOrEqual(10); expect(pressed.x).toBeLessThanOrEqual(110);
    expect(pressed.y).toBeGreaterThanOrEqual(20); expect(pressed.y).toBeLessThanOrEqual(60);
  });

  it('uses CDP commands for typing, scrolling, and navigation', async () => {
    const send = vi.fn().mockResolvedValue({});
    const impl = createDebuggerImpl(send, { fast: true, rng: () => 0.5 });
    await impl.type(makeEl(), 'abc'); await impl.scroll(400); await impl.navigate('https://example.test/job');
    expect(send.mock.calls.filter(([method]) => method === 'Input.insertText')).toHaveLength(3);
    expect(send.mock.calls.filter(([, params]) => params?.type === 'mouseWheel')).toHaveLength(4);
    expect(send).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.test/job' });
  });
});
