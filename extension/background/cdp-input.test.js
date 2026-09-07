import { describe, expect, it, vi } from 'vitest';
import { createCdpInput } from './cdp-input.js';

/**
 * 用 chrome.debugger 注入真实输入事件。
 *
 * 读了 Claude in Chrome 的实现（v1.0.91）：它的点击和键盘走的是
 * chrome.debugger.attach + Input.dispatchMouseEvent / dispatchKeyEvent，不是合成
 * 事件。代价是 Chrome 会强制显示「XX 已开始调试此浏览器」的横幅，好处是事件
 * isTrusted，任何页面都拦不住。
 *
 * 我们的合成事件在简道云上验证过可用，所以 CDP 是**兜底**：合成事件失效时才上。
 * 因此挂载必须是懒的、用完即摘——那条横幅只该在真正操作时出现。
 */
function harness({ attachFails = false } = {}) {
  const calls = [];
  const debuggerApi = {
    attach: vi.fn(async (target) => {
      calls.push(`attach:${target.tabId}`);
      if (attachFails) throw new Error('Another debugger is already attached');
    }),
    detach: vi.fn(async (target) => { calls.push(`detach:${target.tabId}`); }),
    sendCommand: vi.fn(async (target, method, params) => { calls.push(`${method}:${target.tabId}`); return {}; }),
  };
  return { debuggerApi, calls, cdp: createCdpInput({ debuggerApi }) };
}

describe('createCdpInput', () => {
  it('第一次用才挂载调试器——横幅只在真正操作时出现', async () => {
    const { cdp, calls } = harness();
    expect(calls).toEqual([]);
    await cdp.click(7, { x: 10, y: 20 });
    expect(calls[0]).toBe('attach:7');
  });

  it('同一个标签页连续操作只挂载一次', async () => {
    const { cdp, calls } = harness();
    await cdp.click(7, { x: 1, y: 2 });
    await cdp.click(7, { x: 3, y: 4 });
    expect(calls.filter((c) => c.startsWith('attach:'))).toHaveLength(1);
  });

  it('点击派发 press 和 release 两个事件', async () => {
    const { cdp, calls } = harness();
    await cdp.click(7, { x: 10, y: 20 });
    const mouse = calls.filter((c) => c.startsWith('Input.dispatchMouseEvent'));
    expect(mouse.length).toBeGreaterThanOrEqual(2);
  });

  it('打字用 Input.insertText，不逐字模拟按键', async () => {
    const { cdp, calls } = harness();
    await cdp.type(7, '研究生');
    expect(calls).toContain('Input.insertText:7');
  });

  it('release 之后摘掉调试器，不长期占着', async () => {
    const { cdp, calls } = harness();
    await cdp.click(7, { x: 1, y: 2 });
    await cdp.release(7);
    expect(calls).toContain('detach:7');
  });

  it('摘过之后再操作会重新挂载', async () => {
    const { cdp, calls } = harness();
    await cdp.click(7, { x: 1, y: 2 });
    await cdp.release(7);
    await cdp.click(7, { x: 3, y: 4 });
    expect(calls.filter((c) => c === 'attach:7')).toHaveLength(2);
  });

  it('挂载失败时如实返回 false，不静默吞掉', async () => {
    const { cdp } = harness({ attachFails: true });
    expect(await cdp.click(7, { x: 1, y: 2 })).toBe(false);
  });

  it('挂载失败不会留下脏状态——下次还能重试', async () => {
    const { debuggerApi, cdp } = harness({ attachFails: true });
    await cdp.click(7, { x: 1, y: 2 });
    await cdp.click(7, { x: 1, y: 2 });
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
  });

  it('摘一个没挂过的标签页不出错', async () => {
    const { cdp } = harness();
    await expect(cdp.release(99)).resolves.toBeUndefined();
  });
});
