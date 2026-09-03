import { describe, expect, it, vi } from 'vitest';
import { waitForFormReady } from './ready.js';

/**
 * 真机上踩到的：扩展自主开页后立刻派任务，而简道云这类 SPA 是异步渲染的。
 * content script 在 document_idle 就发了 PAGE_READY，那时表单控件还没出来，
 * 采集到 0 个字段，probe 返回 probed=0——任务「成功」了但什么也没做。
 *
 * 这类假成功比失败更难查：队列清空了、ok=true，看起来一切正常。
 */
describe('waitForFormReady', () => {
  const clockedWait = () => {
    let clock = 0;
    return { now: () => clock, wait: async (ms) => { clock += ms; } };
  };

  it('字段数连续两次相同且大于 0 就算就绪', async () => {
    const counts = [3, 7, 7];
    let i = 0;
    const { now, wait } = clockedWait();
    const result = await waitForFormReady({ countFields: () => counts[Math.min(i++, counts.length - 1)], now, wait });

    expect(result.ready).toBe(true);
    expect(result.count).toBe(7);
  });

  it('还没渲染出来（一直是 0）时等到超时，如实报告没就绪', async () => {
    const { now, wait } = clockedWait();
    const result = await waitForFormReady({ countFields: () => 0, now, wait, timeoutMs: 1000, intervalMs: 200 });

    expect(result.ready).toBe(false);
    expect(result.count).toBe(0);
  });

  it('字段数一直在涨说明还在渲染，等到超时为止', async () => {
    let n = 0;
    const { now, wait } = clockedWait();
    const result = await waitForFormReady({ countFields: () => (n += 2), now, wait, timeoutMs: 1000, intervalMs: 200 });

    expect(result.ready).toBe(false);
    expect(result.count).toBeGreaterThan(0);
  });

  it('一开始就稳定的页面不会白等——第二次采样就返回', async () => {
    const countFields = vi.fn(() => 5);
    const { now, wait } = clockedWait();
    const result = await waitForFormReady({ countFields, now, wait });

    expect(result.ready).toBe(true);
    expect(countFields).toHaveBeenCalledTimes(2);
  });

  it('采集抛错时当作 0，不把整个任务带崩', async () => {
    const { now, wait } = clockedWait();
    const result = await waitForFormReady({
      countFields: () => { throw new Error('DOM 还没准备好'); },
      now, wait, timeoutMs: 600, intervalMs: 200,
    });
    expect(result.ready).toBe(false);
  });
});
