/**
 * 官网申请任务的推送通道（服务端侧）。
 *
 * 此前扩展是**轮询**的：content script 每 1.5 秒发一次心跳唤醒 service
 * worker，service worker 再 GET 一次「有任务吗」。99% 的请求返回 null，任务
 * 最多要等 1.5 秒才被发现，而且整套心跳只是为了绕开「服务端推不过来」。
 *
 * 改成推送之后方向反过来：服务端 enqueue 时直接把任务写进已连接的扩展。
 * 心跳和 busy 锁不再需要；alarm 保留下来当重连看门狗——真机实测 MV3 的 service
 * worker 仍会被反复回收，WebSocket 并不能保活，所以 broadcast 经常送达 0 个
 * 客户端，靠扩展重连时的积压补发（onConnect 里那次 next()）兜住。
 *
 * 这里只放不依赖 ws 的纯逻辑，便于直接测：谁在线、推给谁、收到的帧怎么解析。
 */

/** WebSocket.OPEN。不从 ws 里 import，避免这个模块被测试连带拉起真实依赖。 */
export const OPEN = 1;

export type TaskClient = { readyState?: number; send(data: string): void };

export type ClientMessage =
  | { type: "result"; id: string; result: any }
  | { type: "progress"; id: string; progress: Record<string, unknown> };

type Entry = { userId: string; lastActiveAt: number };

/**
 * 按用户定向的推送通道。
 *
 * 改造前是一个 Set，enqueue 时 broadcast 给全体——多用户下 A 的填表任务（payload
 * 里是 A 的姓名电话履历）会被 B 的浏览器执行，A 点确认后 submit 也可能由 B 的
 * 浏览器、B 的登录态发出。所以这里按 userId 分桶。
 *
 * 同一用户多条连接时**只发最近活跃的一条**：两台电脑都装了插件，发给全部就是
 * 两台同时执行同一次投递 = 重复提交。队列的租约机制配合：派给一条后租约期内不
 * 再派；那条掉线（remove）则下一次派发落到另一条。
 */
export function createTaskBroadcaster(opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<TaskClient, Entry>();

  const isOpen = (client: TaskClient) => (client.readyState ?? OPEN) === OPEN;

  /** 该用户的连接，最近活跃的在前。 */
  const ofUser = (userId: string) =>
    [...clients.entries()].filter(([, e]) => e.userId === userId).sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt).map(([c]) => c);

  const deliverOne = (userId: string, payload: string): number => {
    for (const client of ofUser(userId)) {
      if (!isOpen(client)) { clients.delete(client); continue; }
      try {
        client.send(payload);
        return 1;
      } catch {
        clients.delete(client);
      }
    }
    return 0;
  };

  return {
    add(userId: string, client: TaskClient) { clients.set(client, { userId, lastActiveAt: now() }); },
    remove(client: TaskClient) { clients.delete(client); },
    touch(client: TaskClient) { const e = clients.get(client); if (e) e.lastActiveAt = now(); },
    size(userId?: string) { return userId === undefined ? clients.size : ofUser(userId).length; },

    /** 返回 0 表示该用户没有插件在线——任务只能留在队列里，等重连时 onConnect 补发。 */
    sendToUser(userId: string, task: unknown): number {
      return deliverOne(userId, JSON.stringify({ type: "task", task }));
    },

    /** 原样发一条消息（开发期的 reload 命令），不套 task 外壳。 */
    sendRawToUser(userId: string, message: unknown): number {
      return deliverOne(userId, JSON.stringify(message));
    },
  };
}

/**
 * 解析扩展发来的帧。socket 上什么都可能来，所以一律不抛错，看不懂就返回 null。
 *
 * 缺 result 时补一个失败结果而不是丢弃：任务必须被结掉，否则队列会被它永久
 * 堵住（next() 总是返回同一个任务）。
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  let parsed: any;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.id !== "string" || !parsed.id) return null;
  if (parsed.type === "progress") {
    if (!parsed.progress || typeof parsed.progress !== "object" || Array.isArray(parsed.progress)) return null;
    return { type: "progress", id: parsed.id, progress: parsed.progress };
  }
  if (parsed.type !== "result") return null;
  return {
    type: "result",
    id: parsed.id,
    result: parsed.result ?? { ok: false, error: "扩展未返回结果" },
  };
}
