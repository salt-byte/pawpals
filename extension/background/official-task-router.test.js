import { describe, expect, it, vi } from 'vitest';
import { pickTargetTab, runOfficialTaskCycle } from './official-task-router.js';

const task = { id: 'official_1', kind: 'inspect', url: 'https://acme.mokahr.com/apply/1' };

function harness({ task: queued = task, tabs = [], sendToTab } = {}) {
  const complete = vi.fn(async () => ({ ok: true }));
  const client = { next: vi.fn(async () => queued), complete };
  const listTabs = vi.fn(async () => tabs);
  const send = sendToTab ?? vi.fn(async () => ({ ok: true, provider: 'moka' }));
  return { client, listTabs, sendToTab: send, complete };
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
    const tabs = [{ id: 1, url: 'https://other.mokahr.com/apply/1' }];
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', tabs)).toBe(null);
  });

  it('没有任何标签页匹配时返回 null', () => {
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [])).toBe(null);
  });

  it('URL 解析不了时返回 null，不抛错——chrome://、about:blank 这类标签页要能跳过', () => {
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [{ id: 1, url: 'chrome://newtab/' }])).toBe(null);
    expect(pickTargetTab('不是URL', [{ id: 1, url: 'https://acme.mokahr.com/' }])).toBe(null);
    expect(pickTargetTab('https://acme.mokahr.com/apply/1', [{ id: 1 }])).toBe(null);
  });
});

describe('runOfficialTaskCycle', () => {
  it('没有排队任务时既不查标签页也不回报', async () => {
    const { client, listTabs, sendToTab, complete } = harness({ task: null });
    await runOfficialTaskCycle({ client, listTabs, sendToTab });
    expect(listTabs).not.toHaveBeenCalled();
    expect(sendToTab).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('把任务派给 origin 匹配的标签页，并把结果回报给服务端', async () => {
    const { client, listTabs, sendToTab, complete } = harness({
      tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
    });
    await runOfficialTaskCycle({ client, listTabs, sendToTab });

    expect(sendToTab).toHaveBeenCalledWith(7, { type: 'OFFICIAL_TASK', task });
    expect(complete).toHaveBeenCalledWith('official_1', { ok: true, provider: 'moka' });
  });

  it('没有匹配的标签页时不回报——任务留在队列里，等用户打开那个页面', async () => {
    const { client, listTabs, sendToTab, complete } = harness({
      tabs: [{ id: 7, url: 'https://example.com/' }],
    });
    await runOfficialTaskCycle({ client, listTabs, sendToTab });

    expect(sendToTab).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('标签页里没有 content script 时不回报——任务留着，刷新页面后还能跑', async () => {
    const sendToTab = vi.fn(async () => { throw new Error('Receiving end does not exist'); });
    const { client, listTabs, complete } = harness({
      tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab,
    });
    await expect(runOfficialTaskCycle({ client, listTabs, sendToTab })).resolves.toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('页面返回空结果时也要回报，否则队列会被这个任务永远堵住', async () => {
    const sendToTab = vi.fn(async () => undefined);
    const { client, listTabs, complete } = harness({
      tabs: [{ id: 7, url: 'https://acme.mokahr.com/apply/1' }],
      sendToTab,
    });
    await runOfficialTaskCycle({ client, listTabs, sendToTab });
    expect(complete).toHaveBeenCalledWith('official_1', { ok: false, error: '页面未返回结果' });
  });
});
