import { createSessionClient } from './session-client.js';
import { createOfficialTaskClient } from './official-task-client.js';
import { runOfficialTaskCycle } from './official-task-router.js';

const client = createSessionClient();
const officialClient = createOfficialTaskClient();

/**
 * 官网申请任务的网络侧全部在这里，因为只有 service worker 的 fetch 带
 * host_permissions、不受 CORS 限制；content script 直接 fetch localhost
 * 会稳定失败（详见 official-task-router.js 顶部注释）。
 *
 * 心跳不由这里打：MV3 的 service worker 空闲约 30 秒会被终止，setInterval
 * 既不保活、复活后也不会恢复，轮询会静默停掉。改由 content script 定时发
 * OFFICIAL_TICK——消息事件会把 service worker 唤醒，页面活着心跳就活着。
 */
let officialBusy = false;

async function pumpOfficialTasks() {
  if (officialBusy) return;
  officialBusy = true;
  try {
    await runOfficialTaskCycle({
      client: officialClient,
      listTabs: () => chrome.tabs.query({ url: 'https://*/*' }),
      sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    });
  } catch (error) {
    console.warn('[pawpals] official task cycle failed', error);
  } finally {
    officialBusy = false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/pet.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/loader.js'] });
  } catch (error) {
    console.warn('[pawpals] cannot attach to current tab', error);
  }
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PING_SERVER') {
    client.ping().then((alive) => sendResponse({ alive }));
    return true;
  }
  if (message?.type === 'OPEN_PANEL') {
    if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id });
    sendResponse({ ok: true });
  }
  if (message?.type === 'OFFICIAL_TICK') {
    void pumpOfficialTasks();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'OFFICIAL_PAGE_CONTEXT') {
    officialClient.reportContext(message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
