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
 * 跑一轮：拉任务 → 找标签页 → 派发 → 回报。
 *
 * deps 全部注入，所以这一层不依赖 chrome.* 也不依赖 fetch，可以直接测。
 */
export async function runOfficialTaskCycle({ client, listTabs, sendToTab }) {
  const task = await client.next();
  if (!task) return;

  const tabId = pickTargetTab(task.url, await listTabs());
  if (tabId === null) return;

  let result;
  try {
    result = await sendToTab(tabId, { type: 'OFFICIAL_TASK', task });
  } catch {
    return; // 页面里没有 content script，任务留在队列里等下一轮
  }

  await client.complete(task.id, result ?? { ok: false, error: '页面未返回结果' });
}
