import { describe, expect, it, vi } from 'vitest';
import { ACTIONS, createExecutor, validateAction } from './adapter.js';

describe('action adapter', () => {
  it('validates the four allowed action shapes', () => {
    expect(ACTIONS).toEqual(['click', 'type', 'scroll', 'navigate']);
    expect(validateAction({ action: 'click', index: 3 })).toEqual({ ok: true });
    expect(validateAction({ action: 'type', index: 1 }).ok).toBe(false);
    expect(validateAction({ action: 'explode' }).ok).toBe(false);
    expect(validateAction(null).ok).toBe(false);
  });

  it('forwards a valid target action and rejects stale or missing targets', async () => {
    const impl = { click: vi.fn().mockResolvedValue(undefined) };
    const executor = createExecutor(impl);
    const item = { index: 0, el: {}, fingerprint: { tag: 'button', text: '确定', x: 10, y: 10 } };
    expect(await executor.execute({ action: 'click', index: 0 }, { elements: [item] })).toEqual({ ok: true });
    expect(impl.click).toHaveBeenCalledOnce();
    const stale = { ...item, currentFingerprint: { ...item.fingerprint, text: '取消' } };
    expect((await executor.execute({ action: 'click', index: 0 }, { elements: [stale] })).error).toContain('指纹');
    expect((await executor.execute({ action: 'click', index: 9 }, { elements: [item] })).error).toContain('9');
  });

  it('converts implementation errors to result objects', async () => {
    const executor = createExecutor({ click: vi.fn().mockRejectedValue(new Error('boom')) });
    const result = await executor.execute({ action: 'click', index: 0 }, { elements: [{ index: 0, el: {}, fingerprint: {} }] });
    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
