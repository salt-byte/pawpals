import { createSessionClient, SERVER_BASE } from './session-client.js';
import { createOfficialTaskClient } from './official-task-client.js';
import { createOfficialDispatcher } from './official-task-router.js';
import { createTabGrouper } from './tab-group.js';

const client = createSessionClient();
const officialClient = createOfficialTaskClient();

/**
 * 官网申请任务改走 WebSocket 推送。
 *
 * 之前是轮询：content script 每 1.5 秒发一次心跳把 service worker 唤醒，service
 * worker 再 GET 一次「有任务吗」。99% 的请求返回 null，任务最多要等 1.5 秒才被
 * 发现，而那整套心跳只是为了绕开「服务端推不过来」这一件事。
 *
 * 换成推送之后，服务端 enqueue 时直接写进这条连接，心跳、busy 锁、每 1.5 秒
 * 一次的 GET 全部不再需要。顺带解决了 MV3 的保活问题：一条活着的 WebSocket
 * 本身就会重置 service worker 的空闲计时器。
 *
 * 网络仍然只能在这里做——content script 的跨域 fetch 受页面 origin 的 CORS 管，
 * 直连 localhost 会稳定失败（详见 official-task-router.js 顶部注释）。
 */
const SOCKET_URL = `${SERVER_BASE.replace(/^http/, 'ws')}/ws/official`;

let socket = null;

function sendToServer(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

/**
 * 扩展自己开的标签页会被归进一个带名字的分组，用户一眼看得出是谁开的。
 * 归组失败不影响投递（见 tab-group.js）。
 */
const tabGrouper = createTabGrouper({
  groupTabs: (options) => chrome.tabs.group(options),
  updateGroup: (groupId, props) => chrome.tabGroups.update(groupId, props),
  queryGroups: (query) => chrome.tabGroups.query(query),
});

const dispatcher = createOfficialDispatcher({
  listTabs: () => chrome.tabs.query({ url: 'https://*/*' }),
  sendToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  // 自主开页：申请页没开着就自己开一个后台标签页。submit 不在可自动开页的类型
  // 里——提交只发生在用户亲眼确认过的那个页面上。
  openTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab?.id) await tabGrouper.add(tab.id);
    return tab;
  },
  reportResult: (id, result) => sendToServer({ type: 'result', id, result }),
});

function connectOfficialSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(SOCKET_URL);
  } catch {
    socket = null;
    return;
  }
  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload?.type === 'task' && payload.task) void dispatcher.accept(payload.task);
  });
  socket.addEventListener('close', () => { socket = null; });
  socket.addEventListener('error', () => { /* close 会紧跟着来，在那里清理 */ });
}

/**
 * 重连看门狗。
 *
 * 连接活着的时候用不上它——连接本身就保活。但连接一断，service worker 可能随
 * 之被回收，那就没有任何东西会去重连了。alarms 能唤醒被回收的 service worker，
 * 30 秒一次纯粹是兜底，不是在轮询任务。
 */
chrome.alarms.create('pawpals-official-socket', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pawpals-official-socket') connectOfficialSocket();
});

chrome.runtime.onStartup.addListener(connectOfficialSocket);
chrome.runtime.onInstalled.addListener(connectOfficialSocket);
connectOfficialSocket();

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
  if (message?.type === 'OFFICIAL_PAGE_READY') {
    // 页面上线：顺手确保连接活着，上报页面上下文，并把待办里同源的任务补派过
    // 去——任务可能是在这个页面加载完成之前就推过来的。
    connectOfficialSocket();
    void officialClient.reportContext(message.payload);
    void dispatcher.onPageReady(message.origin);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
