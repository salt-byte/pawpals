import { describe, expect, it, vi } from 'vitest';
import { pickTargetTab, createOfficialDispatcher } from './official-task-router.js';

const task = { id: 'official_1', kind: 'inspect', url: 'https://acme.mokahr.com/apply/1' };
const submitTask = { id: 'official_2', kind: 'submit', url: 'https://acme.mokahr.com/apply/1' };

function harness({ tabs = [], sendToTab, openTab } = {}) {
  const reportResult = vi.fn();
  const deps = {
    listTabs: vi.fn(async () => tabs),
    sendToTab: sendToTab ?? vi.fn(async () => ({ ok: true, provider: 'moka' })),
    openTab,
    reportResult,
  };
  return { deps, dispatcher: createOfficialDispatcher(deps), reportResult };
}

describe('pickTargetTab', () => {
  it('按 origin 匹配，路径不同也算同一个站', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/' },
      { id: 2, url: 'https://acme.mokahr.com/apply/999?from=x' },
    ];
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', tabs)).toBe(2);
  });

  it('origin 不同就不匹配——子域名不是同一个 origin', () => {
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [{ id: 1, url: 'https://other.mokahr.com/apply/1' }])).toBe(null);
  });

  it('没有任何标签页匹配时返回 null', () => {
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [])).toBe(null);
  });

  it('URL 解析不了时返回 null，不抛错——chrome://、about:blank 这类要能跳过', () => {
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [{ id: 1, url: 'chrome://newtab/' }])).toBe(null);
    expect(pickTargetTab('不是URL', [{ id: 1, url: 'https://acme.mokahr.com/' }])).toBe(null);
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [{ id: 1 }])).toBe(null);
  });
});

describe('createOfficialDispatcher：收到推送', () => {
  it('目标标签页开着就直接派发，并把结果回报给服务端', async () => {
    const { deps, dispatcher, reportResult } = harness({ tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }] });
    await dispatcher.accept(task);

    expect(deps.sendToTab).toHaveBeenCalledWith(7, { type: 'OFFICIAL_TASK', task });
    expect(reportResult).toHaveBeenCalledWith('official_1', { ok: true, provider: 'moka' });
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it('页面返回空结果也要回报——不回报会把服务端队列永久堵住', async () => {
    const { dispatcher, reportResult } = harness({
      tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: vi.fn(async () => undefined),
    });
    await dispatcher.accept(task);
    expect(reportResult).toHaveBeenCalledWith('official_1', { ok: false, error: '页面未返回结果' });
  });

  it('页面里没有 content script 时不回报，任务转入待办等页面就绪', async () => {
    const { dispatcher, reportResult } = harness({
      tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: vi.fn(async () => { throw new Error('Receiving end does not exist'); }),
    });
    await dispatcher.accept(task);

    expect(reportResult).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });
});

describe('createOfficialDispatcher：自主开页', () => {
  it('标签页没开就自己开一个，任务转入待办，这一轮不回报', async () => {
    const openTab = vi.fn(async () => ({ id: 9 }));
    const { deps, dispatcher, reportResult } = harness({ tabs: [], openTab });
    await dispatcher.accept(task);

    expect(openTab).toHaveBeenCalledWith('https://acme.mokahr.com/apply/1');
    expect(deps.sendToTab).not.toHaveBeenCalled();
    expect(reportResult).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('submit 永不自动开页——提交只能发生在用户亲眼确认过的那个页面上', async () => {
    const openTab = vi.fn(async () => ({ id: 9 }));
    const { dispatcher, reportResult } = harness({ tabs: [], openTab });
    await dispatcher.accept(submitTask);

    expect(openTab).not.toHaveBeenCalled();
    expect(reportResult).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('同一个任务只开一次页', async () => {
    const openTab = vi.fn(async () => ({ id: 9 }));
    const { dispatcher } = harness({ tabs: [], openTab });
    await dispatcher.accept(task);
    await dispatcher.accept(task);
    await dispatcher.accept(task);
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('不提供 openTab 时不开页，但任务照样转入待办——用户手动打开也能接上', async () => {
    const { dispatcher, reportResult } = harness({ tabs: [] });
    await dispatcher.accept(task);
    expect(reportResult).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });
});

describe('createOfficialDispatcher：页面就绪后补派', () => {
  it('同源页面就绪时，待办里的任务被派发并回报', async () => {
    let tabs = [];
    const reportResult = vi.fn();
    const sendToTab = vi.fn(async () => ({ ok: true }));
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => tabs,
      sendToTab,
      openTab: vi.fn(async () => ({ id: 9 })),
      reportResult,
    });

    await dispatcher.accept(task);
    expect(dispatcher.pendingCount()).toBe(1);

    // 页面加载完成，content script 上线
    tabs = [{ id: 9, url: 'https://acme.mokahr.com/apply/1' }];
    await dispatcher.onPageReady('https://acme.mokahr.com');

    expect(sendToTab).toHaveBeenCalledWith(9, { type: 'OFFICIAL_TASK', task });
    expect(reportResult).toHaveBeenCalledWith('official_1', { ok: true });
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it('不同源的页面就绪时不动待办里的任务', async () => {
    const { dispatcher, deps } = harness({ tabs: [] });
    await dispatcher.accept(task);
    await dispatcher.onPageReady('https://example.com');

    expect(deps.sendToTab).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('待办为空时页面就绪什么都不做', async () => {
    const { dispatcher, deps } = harness({ tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }] });
    await dispatcher.onPageReady('https://acme.mokahr.com');
    expect(deps.sendToTab).not.toHaveBeenCalled();
  });

  it('submit 任务在页面就绪后也能补派——不自动开页不等于不派发', async () => {
    let tabs = [];
    const sendToTab = vi.fn(async () => ({ ok: true, submittedAt: 'x' }));
    const dispatcher = createOfficialDispatcher({ listTabs: async () => tabs, sendToTab, reportResult: vi.fn() });

    await dispatcher.accept(submitTask);
    tabs = [{ id: 3, url: 'https://acme.mokahr.com/apply/1' }];
    await dispatcher.onPageReady('https://acme.mokahr.com');

    expect(sendToTab).toHaveBeenCalledWith(3, { type: 'OFFICIAL_TASK', task: submitTask });
  });
});

/**
 * 真机根因：Chrome 会丢弃后台标签页（document.wasDiscarded === true）。被丢弃
 * 后 content script 就没了，chrome.tabs.sendMessage **挂住不返回**——而
 * tryDispatch 只捕获抛错，捕获不了「永远不返回」，任务就悬到超时。
 *
 * 症状很有迷惑性：刚导航完标签页是活的，2 秒成功；放一会儿被丢弃，就必然超时。
 */
describe('派发要有超时——标签页被丢弃时 sendMessage 会挂住', () => {
  it('派发挂住时按失败处理，任务留在待办等页面重新就绪', async () => {
    const sendToTab = vi.fn(() => new Promise(() => {}));   // 永远不 resolve
    const reportResult = vi.fn();
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab, reportResult, sendTimeoutMs: 50,
    });

    await dispatcher.accept(task);
    expect(reportResult).not.toHaveBeenCalled();
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('正常返回的派发不受超时影响', async () => {
    const reportResult = vi.fn();
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: async () => ({ ok: true }),
      reportResult, sendTimeoutMs: 5000,
    });

    await dispatcher.accept(task);
    expect(reportResult).toHaveBeenCalledWith('official_1', { ok: true });
    expect(dispatcher.pendingCount()).toBe(0);
  });
});

