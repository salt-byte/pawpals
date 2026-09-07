import { describe, expect, it, vi } from 'vitest';
import { createSocketHost } from './socket-host.js';

/**
 * offscreen document 承载 WebSocket，service worker 只做派发。
 *
 * MV3 的 service worker 是**设计成会被回收的**，怎么保活都是在跟浏览器较劲——
 * 今天为此打了五个补丁（20 秒调 API 保活、30 秒 alarm 看门狗、ping/pong 探活、
 * 新连接作废租约、派发失败刷新标签页），真机日志里仍有几十次断开重连。
 *
 * offscreen document 是一个真正的页面上下文，不受 service worker 生命周期管辖，
 * 是 Chrome 官方给「扩展需要长期干活」准备的出口。连接放这里就不会断。
 *
 * 但 offscreen 拿不到 chrome.tabs，所以分工是：
 *   offscreen        持连接，收到任务转发给 service worker
 *   service worker   做标签页的事；被转发消息唤醒，全程有事件在手
 */
function host({ socketFactory, notify } = {}) {
  const sockets = [];
  const factory = socketFactory ?? (() => {
    const s = {
      readyState: 0, sent: [], listeners: {},
      addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
      send(d) { this.sent.push(d); },
      close() { this.readyState = 3; this.fire('close', {}); },
      fire(t, e) { (this.listeners[t] ?? []).forEach((fn) => fn(e)); },
      open() { this.readyState = 1; this.fire('open', {}); },
    };
    sockets.push(s);
    return s;
  });
  return { sockets, api: createSocketHost({ url: 'ws://x/y', socketFactory: factory, notify: notify ?? vi.fn() }) };
}

describe('createSocketHost', () => {
  it('连上之后把收到的任务转发出去', () => {
    const notify = vi.fn();
    const { sockets, api } = host({ notify });
    api.connect();
    sockets[0].open();
    sockets[0].fire('message', { data: JSON.stringify({ type: 'task', task: { id: 't1', kind: 'inspect' } }) });

    expect(notify).toHaveBeenCalledWith({ type: 'task', task: { id: 't1', kind: 'inspect' } });
  });

  it('非 JSON 的帧忽略掉，不抛错', () => {
    const notify = vi.fn();
    const { sockets, api } = host({ notify });
    api.connect();
    sockets[0].open();
    expect(() => sockets[0].fire('message', { data: '不是JSON' })).not.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });

  it('把结果沿同一条连接送回服务端', () => {
    const { sockets, api } = host();
    api.connect();
    sockets[0].open();
    expect(api.send({ type: 'result', id: 't1', result: { ok: true } })).toBe(true);
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ type: 'result', id: 't1' });
  });

  it('连接没就绪时 send 返回 false，不静默丢弃', () => {
    const { api } = host();
    expect(api.send({ type: 'result', id: 't1' })).toBe(false);
  });

  it('已经连着时不重复建连', () => {
    const { sockets, api } = host();
    api.connect();
    sockets[0].open();
    api.connect();
    expect(sockets).toHaveLength(1);
  });

  it('断线后再 connect 会建新连接——offscreen 不会死，但服务端可能重启', () => {
    const { sockets, api } = host();
    api.connect();
    sockets[0].open();
    sockets[0].close();
    api.connect();
    expect(sockets).toHaveLength(2);
  });

  it('建连本身抛错时不崩，下次还能重试', () => {
    let first = true;
    const made = [];
    const api = createSocketHost({
      url: 'ws://x/y', notify: vi.fn(),
      socketFactory: () => {
        if (first) { first = false; throw new Error('建连失败'); }
        const s = { readyState: 1, addEventListener() {}, send() {}, close() {} };
        made.push(s); return s;
      },
    });
    expect(() => api.connect()).not.toThrow();
    api.connect();
    expect(made).toHaveLength(1);
  });
});
