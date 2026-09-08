import { createSessionClient, SERVER_BASE } from './session-client.js';
import { createOfficialTaskClient } from './official-task-client.js';
import { createOfficialDispatcher } from './official-task-router.js';
import { createTabGrouper } from './tab-group.js';
import { createCdpInput } from './cdp-input.js';

const client = createSessionClient();

/**
 * CDP 输入。合成事件失效时的兜底——chrome.debugger 会让 Chrome 挂一条「已开始
 * 调试此浏览器」的横幅，所以只在 content script 明确请求时才用，用完即摘。
 */
const cdpInput = createCdpInput({ debuggerApi: chrome.debugger });
const officialClient = createOfficialTaskClient();

/**
 * 官网申请任务改走 WebSocket 推送。
 *
 * 之前是轮询：content script 每 1.5 秒发一次心跳把 service worker 唤醒，service
 * worker 再 GET 一次「有任务吗」。99% 的请求返回 null，任务最多要等 1.5 秒才被
 * 发现，而那整套心跳只是为了绕开「服务端推不过来」这一件事。
 *
 * 换成推送之后，服务端 enqueue 时直接写进这条连接，心跳、busy 锁、每 1.5 秒
 * 一次的 GET 全部不再需要。
 *
 * 注意：曾以为「一条活着的 WebSocket 会让 service worker 不被回收」，真机日志
 * 推翻了这个说法——连接日志里是四十多组「已连接 → 断开」的循环，service
 * worker 一直在被回收。真正让链路可用的是下面那个 30 秒的 alarm 看门狗：它把
 * service worker 拉起来重连，重连时再从队列补发积压任务。
 *
 * 所以「即时推送」要打折扣：任务入队时扩展常常处于断开状态，broadcast 送达 0
 * 个客户端，实际是靠重连补发拿到的（实测端到端约 2 秒）。这仍然远好于轮询——
 * 空闲时零请求、也不需要页面开着才有心跳——但它不是零延迟。
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

/**
 * 任务在飞行中时保活 service worker。
 *
 * MV3 的 service worker 空闲约 30 秒被回收，而**调用扩展 API 会重置这个计时器**。
 * 一个任务要走「收到 → 找/开标签页 → 等表单就绪（最多 8 秒）→ 页面执行 → 回报」，
 * 中间大段时间都在 await，没有任何 API 调用，计时器照常走完——真机上因此看到
 * 每 15~30 秒一次干净断开、31 次重连，任务做到一半进程就没了，重发再死，循环。
 *
 * 所以只在有任务在手时每 20 秒调一次最便宜的 API，任务做完立刻停——不做无谓保活。
 */
let inFlight = 0;
let keepAliveTimer = null;
function beginWork() {
  inFlight += 1;
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* 已失效 */ } }, 20000);
}
function endWork() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight > 0 || !keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}
/** 包住一段可能很长的异步工作，期间保活。 */
async function withKeepAlive(run) {
  beginWork();
  try { return await run(); } finally { endWork(); }
}

const dispatcher = createOfficialDispatcher({
  listTabs: () => chrome.tabs.query({ url: 'https://*/*' }),
  sendToTab: async (tabId, message) => {
    // Chrome 会丢弃后台标签页，content script 随之消失。标成不可丢弃，
    // 否则任务派下去就石沉大海（派发侧另有超时兜底）。
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch { /* 标签页没了 */ }
    return chrome.tabs.sendMessage(tabId, message);
  },
  // 自主开页：申请页没开着就自己开一个后台标签页。submit 不在可自动开页的类型
  // 里——提交只发生在用户亲眼确认过的那个页面上。
  openTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab?.id) {
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* 忽略 */ }
      await tabGrouper.add(tab.id);
    }
    return tab;
  },
  reportResult: (id, result) => sendToServer({ type: 'result', id, result }),
  // 标签页被丢弃后只能靠重新加载把 content script 请回来
  reloadTab: (tabId) => chrome.tabs.reload(tabId),
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
    if (payload?.type === 'task' && payload.task) void withKeepAlive(() => dispatcher.accept(payload.task));
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
  if (message?.type === 'OFFICIAL_CDP_CLICK') {
    // content script 拿不到 chrome.debugger，坐标由它算、这里派发
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return false; }
    cdpInput.click(tabId, { x: message.x, y: message.y }).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (message?.type === 'OFFICIAL_CDP_TYPE') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return false; }
    cdpInput.type(tabId, message.text).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (message?.type === 'OFFICIAL_CAPTURE') {
    /**
     * 截当前可见区域。视觉兜底用——有些控件没有任何无障碍信息、DOM 也驱动不了
     * （真机上帆软那 5 个「是否有…经历」probe 探回来 0 个选项，面板压根没开），
     * 那时候唯一还成立的信息源就是「它在屏幕上长什么样」。
     *
     * captureVisibleTab 需要 activeTab 或 <all_urls> 权限，我们的 host_permissions 已覆盖。
     * 只截可见区域，所以调用方必须先把目标滚进视口。
     */
    const tab = sender.tab;
    if (!tab?.id) { sendResponse({ ok: false, error: 'no_tab' }); return false; }
    // captureVisibleTab 截的是**可见**标签页，而申请页是后台开的——不先切到前台
    // 就会截到用户当前在看的那个页面，模型据此给的坐标全是错的。视觉是最后一招，
    // 抢一下焦点可以接受，但只在真的走到这一步时才抢。
    (async () => {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
        await new Promise((r) => setTimeout(r, 400));
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        sendResponse(dataUrl ? { ok: true, dataUrl } : { ok: false, error: '截图为空' });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }
  if (message?.type === 'OFFICIAL_CDP_RELEASE') {
    if (sender.tab?.id) void cdpInput.release(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'OFFICIAL_PAGE_READY') {
    // 页面上线：顺手确保连接活着，上报页面上下文，并把待办里同源的任务补派过
    // 去——任务可能是在这个页面加载完成之前就推过来的。
    connectOfficialSocket();
    void officialClient.reportContext(message.payload);
    // 把上线的那个标签页一并给过去：同一申请页常常开着好几个标签页，按 URL
    // 挑会挑中前几次留下的死页（见 official-task-router.js）。
    void withKeepAlive(() => dispatcher.onPageReady(message.origin, sender.tab?.id));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'OFFICIAL_TASK_PROGRESS') {
    // 进度是 best-effort：最终 result 才会结掉任务；此处失败不应影响页面执行。
    connectOfficialSocket();
    const sent = sendToServer({ type: 'progress', id: message.id, progress: message.progress || {} });
    sendResponse({ ok: sent });
    return false;
  }
  return false;
});
