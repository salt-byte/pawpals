import { describe, expect, it, vi } from 'vitest';
import { sendToBackground } from './bg-bridge.js';

describe('sendToBackground', () => {
  it('正常时把 service worker 的回复原样带回来', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    await expect(sendToBackground(sendMessage, { type: 'OFFICIAL_TICK' })).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'OFFICIAL_TICK' });
  });

  it('service worker 没应答（Promise 拒绝）时吞掉，返回 null', async () => {
    const sendMessage = vi.fn(async () => { throw new Error('Could not establish connection'); });
    await expect(sendToBackground(sendMessage, { type: 'OFFICIAL_TICK' })).resolves.toBe(null);
  });

  it('扩展重载后上下文失效——sendMessage 同步抛错，也必须吞掉', async () => {
    // 这是 .catch() 接不住的那种：错误在返回 Promise 之前就抛出来了。
    const sendMessage = vi.fn(() => { throw new Error('Extension context invalidated.'); });
    await expect(sendToBackground(sendMessage, { type: 'OFFICIAL_TICK' })).resolves.toBe(null);
  });

  it('sendMessage 返回的不是 Promise 时也不炸', async () => {
    const sendMessage = vi.fn(() => undefined);
    await expect(sendToBackground(sendMessage, { type: 'OFFICIAL_TICK' })).resolves.toBeUndefined();
  });
});
