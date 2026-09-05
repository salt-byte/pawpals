/**
 * 官网申请任务的派发路由，跑在 service worker 里。
 *
 * 为什么不放在 content script：MV3 从 Chrome 85 起，content script 的跨域
 * fetch 要按**页面的** origin 走 CORS，host_permissions 不再豁免。服务端
 * （Express）没有任何 CORS 中间件，于是 content script 直接 fetch
 * http://localhost:3000 会稳定拿到 "TypeError: Failed to fetch"。
 * service worker 的 fetch 带 host_permissions，不受 CORS 限制。
 *
 * 所以职责变成：service worker 拉任务、找目标标签页、把任务发进去、把结果
 * 回报给服务端；content script 只负责在页面里执行，不碰网络。
 *
 * 派发失败（没有匹配标签页、或页面里没有 content script）一律**不回报**，
 * 任务留在队列里——用户过会儿打开那个申请页，下一轮就能跑起来。只有页面
 * 真的执行了（哪怕返回空）才回报，否则队列会被这个任务永远堵住。
 */

/**
 * 可以自主开页的任务类型。
 *
 * submit 不在其中，而且这是安全约束不是遗漏：提交只应发生在用户已经打开、
 * 亲眼看过并回了「确认投递」的那个页面上。如果那个标签页已经被关掉，正确的
 * 反应是让任务留在队列里，而不是重新开一个页面把表单交上去。
 */
const AUTO_OPEN_KINDS = ['inspect', 'probe', 'upload', 'fill'];

/** 找到 origin 与任务 URL 相同的标签页；找不到或 URL 解析不了都返回 null。 */
export function pickTargetTab(taskUrl, tabs) {
  let wanted;
  try {
    wanted = new URL(taskUrl).origin;
  } catch {
    return null;
  }
  for (const tab of tabs ?? []) {
    try {
      if (new URL(tab.url).origin === wanted) return tab.id;
    } catch {
      // chrome://、about:blank 这类标签页解析不了，跳过即可
    }
  }
  return null;
}

/**
 * 任务派发器。收到服务端推来的任务，找到（或打开）目标标签页，把任务交给页面
 * 里的 content script，再把结果回报回去。
 *
 * 全事件驱动，没有轮询也没有心跳：任务从 socket 推进来触发 accept()，页面加载
 * 完成触发 onPageReady()。这两个事件之外这里不做任何事。
 *
 * 派发不成功的任务留在 pending 里而不是丢弃或回报失败——页面可能还在加载，或
 * 者用户过会儿才打开申请页。只有页面**真的执行了**（哪怕返回空）才回报，否则
 * 服务端队列会被这个任务永久堵住。
 */
/**
 * 派发的等待上限。
 *
 * Chrome 会丢弃后台标签页（document.wasDiscarded === true），被丢弃后 content
 * script 就没了，chrome.tabs.sendMessage **挂住不返回**——只捕获抛错是接不住
 * 「永远不返回」的。真机症状很有迷惑性：刚导航完标签页是活的，2 秒成功；放一会
 * 儿被丢弃，就必然超时。
 */
const DEFAULT_SEND_TIMEOUT_MS = 20000;

export function createOfficialDispatcher({ listTabs, sendToTab, openTab, reportResult, reloadTab, sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS }) {
  /** 已收到但还没派出去的任务。 */
  const pending = new Map();
  /** 已经为哪些任务开过页，避免页面加载期间重复开。 */
  const openedFor = new Set();
  /** 已经为哪些任务刷过页，避免反复刷新用户正在看的页面。 */
  const reloadedFor = new Set();

  /** 尝试把一个任务交给页面。成功返回 true（此时已回报），否则 false。 */
  async function tryDispatch(task) {
    const tabId = pickTargetTab(task.url, await listTabs());
    if (tabId === null) return false;

    const TIMEOUT = Symbol('dispatch-timeout');
    let result;
    let timer;
    try {
      result = await Promise.race([
        sendToTab(tabId, { type: 'OFFICIAL_TASK', task }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), sendTimeoutMs); }),
      ]);
    } catch {
      return false; // 页面里还没有 content script
    } finally {
      clearTimeout(timer);
    }
    // 挂住多半是标签页被丢弃了。光等没用——content script 已经没了，PAGE_READY
    // 永远不会来。主动刷一下把它请回来，刷完的 PAGE_READY 会带着待办任务重来。
    if (result === TIMEOUT) {
      if (reloadTab && !reloadedFor.has(task.id)) {
        reloadedFor.add(task.id);
        try { await reloadTab(tabId); } catch { /* 标签页没了 */ }
      }
      return false;
    }
    reportResult(task.id, result ?? { ok: false, error: '页面未返回结果' });
    return true;
  }

  return {
    /** 服务端推来一个任务。 */
    async accept(task) {
      if (!task?.id) return;
      if (await tryDispatch(task)) {
        pending.delete(task.id);
        return;
      }
      pending.set(task.id, task);
      if (!openTab || !AUTO_OPEN_KINDS.includes(task.kind) || openedFor.has(task.id)) return;
      openedFor.add(task.id);
      try {
        await openTab(task.url);
      } catch {
        // 开页失败：任务留在待办里，用户手动打开申请页也能接上
      }
    },

    /** 某个页面的 content script 上线了，把待办里同源的任务补派给它。 */
    async onPageReady(origin) {
      for (const task of [...pending.values()]) {
        let taskOrigin;
        try {
          taskOrigin = new URL(task.url).origin;
        } catch {
          pending.delete(task.id);
          continue;
        }
        if (taskOrigin !== origin) continue;
        if (await tryDispatch(task)) pending.delete(task.id);
      }
    },

    pendingCount: () => pending.size,
  };
}
