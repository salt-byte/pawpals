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
/**
 * 连接不再放在这里，改由 offscreen document 承载。
 *
 * MV3 的 service worker 是设计成会被回收的，怎么保活都是在跟浏览器较劲：今天为此
 * 打了五个补丁（20 秒调 API 保活、30 秒 alarm 看门狗、ping/pong 探活、新连接作废
 * 租约、派发失败刷新标签页），真机日志里仍有几十次断开重连、任务反复做到一半就没了。
 *
 * offscreen document 不受这个生命周期管辖，是 Chrome 官方给「扩展需要长期干活」
 * 准备的出口。但它拿不到 chrome.tabs，所以分工是：
 *   offscreen        持连接；收到任务转发过来（消息事件顺带把这里唤醒）
 *   service worker   做标签页的事
 */
let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (existing?.length) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS'],
        justification: '与本地 PawPals 服务保持长连接，接收官网投递任务',
      });
    } catch (error) {
      // 已经存在会抛错，属于正常；其余情况下次再试
      if (!String(error?.message || '').includes('Only a single offscreen')) offscreenReady = null;
    }
  })();
  return offscreenReady;
}

/** 结果经 offscreen 送回服务端——连接在那边。 */
function sendToServer(message) {
  void ensureOffscreen().then(() =>
    chrome.runtime.sendMessage({ type: 'OFFICIAL_SOCKET_SEND', payload: message }).catch(() => {})
  );
  return true;
}

chrome.runtime.onStartup.addListener(() => void ensureOffscreen());
chrome.runtime.onInstalled.addListener(() => void ensureOffscreen());
void ensureOffscreen();

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
  if (message?.type === 'OFFICIAL_SOCKET_MESSAGE') {
    const payload = message.payload;
    if (payload?.type === 'task' && payload.task) void withKeepAlive(() => dispatcher.accept(payload.task));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'OFFICIAL_PAGE_READY') {
    // 页面上线：顺手确保连接活着，上报页面上下文，并把待办里同源的任务补派过
    // 去——任务可能是在这个页面加载完成之前就推过来的。
    void ensureOffscreen();
    void officialClient.reportContext(message.payload);
    void withKeepAlive(() => dispatcher.onPageReady(message.origin));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'OFFICIAL_TASK_PROGRESS') {
    // 进度是 best-effort：最终 result 才会结掉任务；此处失败不应影响页面执行。
    void ensureOffscreen();
    const sent = sendToServer({ type: 'progress', id: message.id, progress: message.progress || {} });
    sendResponse({ ok: sent });
    return false;
  }
  return false;
});
