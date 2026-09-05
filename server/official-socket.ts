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

export function createTaskBroadcaster() {
  const clients = new Set<TaskClient>();

  const isOpen = (client: TaskClient) => (client.readyState ?? OPEN) === OPEN;

  return {
    add(client: TaskClient) { clients.add(client); },
    remove(client: TaskClient) { clients.delete(client); },
    size() { return clients.size; },

    /**
     * 把任务推给所有在线扩展，返回实际送达数。
     *
     * 返回 0 表示没有扩展在线——调用方据此知道这个任务只能留在队列里，等扩展
     * 连上来时再由 onConnect 补发。
     *
     * 送不出去的客户端顺手清掉：readyState 不是 OPEN，或者 send 抛错（连接刚
     * 断但 close 事件还没到）。
     */
    broadcast(task: unknown): number {
      const payload = JSON.stringify({ type: "task", task });
      let delivered = 0;
      for (const client of [...clients]) {
        if (!isOpen(client)) { clients.delete(client); continue; }
        try {
          client.send(payload);
          delivered += 1;
        } catch {
          clients.delete(client);
        }
      }
      return delivered;
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
