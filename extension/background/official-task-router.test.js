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

/**
 * 光有超时不够：标签页被丢弃后 content script 就没了，除非页面重新加载，否则
 * PAGE_READY 永远不会来，待办里的任务就一直等下去。所以派发失败时要主动把那个
 * 标签页刷一下，让 content script 回来。
 */
describe('派发失败时复活标签页', () => {
  it('派发挂住后刷新目标标签页，让 content script 回来', async () => {
    const reloadTab = vi.fn(async () => {});
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: () => new Promise(() => {}),
      reportResult: vi.fn(), reloadTab, sendTimeoutMs: 50,
    });

    await dispatcher.accept(task);
    expect(reloadTab).toHaveBeenCalledWith(7);
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('同一个任务只刷一次，不反复刷页面', async () => {
    const reloadTab = vi.fn(async () => {});
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: () => new Promise(() => {}),
      reportResult: vi.fn(), reloadTab, sendTimeoutMs: 30,
    });
    await dispatcher.accept(task);
    await dispatcher.onPageReady('https://acme.mokahr.com');
    expect(reloadTab).toHaveBeenCalledTimes(1);
  });

  it('派发成功时不刷页面', async () => {
    const reloadTab = vi.fn(async () => {});
    const dispatcher = createOfficialDispatcher({
      listTabs: async () => [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab: async () => ({ ok: true }), reportResult: vi.fn(), reloadTab,
    });
    await dispatcher.accept(task);
    expect(reloadTab).not.toHaveBeenCalled();
  });
});


/**
 * 陈旧标签页。
 *
 * 真机症状：同一个申请页开着好几个标签页（前几次自主开页留下的），其中旧的那些
 * content script 早就随扩展重载失效了。pickTargetTab 按 URL 挑，永远挑中列表里
 * 第一个——也就是死的那个。发消息被拒 → 任务进待办 → 开新标签页 → 新页上线触发
 * onPageReady → 又按 URL 重新挑 → 再次挑中死的。循环：标签页越开越多，结果永远
 * 回不来，服务端看到的是彻底的沉默。
 *
 * 修法：谁上线就派给谁。onPageReady 知道是哪个标签页上线的，不该再去猜。
 */
describe('派给刚上线的那个标签页', () => {
  function harness() {
    const sent = [];
    const reported = [];
    return {
      sent,
      reported,
      dispatcher: createOfficialDispatcher({
        // 两个同 URL 的标签页：1 是陈旧的死页，2 是刚开的活页
        listTabs: async () => [
          { id: 1, url: 'https://form.example.com/a' },
          { id: 2, url: 'https://form.example.com/a' },
        ],
        sendToTab: async (tabId, message) => {
          sent.push(tabId);
          if (tabId === 1) throw new Error('Could not establish connection');
          return { ok: true, from: tabId, ...message };
        },
        openTab: async () => ({ id: 2 }),
        reportResult: (id, result) => reported.push({ id, result }),
        reloadTab: async () => {},
        sendTimeoutMs: 50,
      }),
    };
  }

  const task = { id: 't1', kind: 'inspect', url: 'https://form.example.com/a' };

  it('第一次派发挑中死页，任务留在待办', async () => {
    const { dispatcher, reported } = harness();
    await dispatcher.accept(task);
    expect(reported).toHaveLength(0);
    expect(dispatcher.pendingCount()).toBe(1);
  });

  it('新页上线后派给它本人，而不是重新按 URL 挑', async () => {
    const { dispatcher, sent, reported } = harness();
    await dispatcher.accept(task);
    sent.length = 0;
    await dispatcher.onPageReady('https://form.example.com', 2);
    expect(sent).toEqual([2]);
    expect(reported).toEqual([{ id: 't1', result: { ok: true, from: 2, type: 'OFFICIAL_TASK', task } }]);
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it('没给 tabId 时退回原来的按 URL 挑，老调用方不受影响', async () => {
    const { dispatcher, sent } = harness();
    await dispatcher.accept(task);
    sent.length = 0;
    await dispatcher.onPageReady('https://form.example.com');
    expect(sent[0]).toBe(1);
  });
});
