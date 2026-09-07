/**
 * 承载服务端连接的那一半，跑在 offscreen document 里。
 *
 * MV3 的 service worker 是**设计成会被回收的**，怎么保活都是在跟浏览器较劲。
 * 今天为此打了五个补丁——每 20 秒调一次 API 保活、30 秒 alarm 看门狗、ping/pong
 * 探活、新连接作废租约、派发失败刷新标签页——真机日志里仍然有几十次断开重连，
 * 任务反复做到一半进程就没了。
 *
 * offscreen document 是一个真正的页面上下文，不受 service worker 的生命周期管辖，
 * 是 Chrome 官方给「扩展需要长期干活」准备的出口。连接放这里就不会跟着进程一起断。
 *
 * 但 offscreen 拿不到 chrome.tabs，所以分工必须是：
 *   offscreen        持连接；收到任务转发给 service worker
 *   service worker   做标签页的事；被转发消息唤醒，全程手里有事件
 *
 * 这里只放不依赖 chrome.* 的部分，便于直接测。
 */
export function createSocketHost({ url, socketFactory, notify }) {
  let socket = null;

  const isLive = () => socket && (socket.readyState === 0 || socket.readyState === 1);

  return {
    /** 建连。已经连着就什么都不做；建连本身抛错也不崩，下次还能重试。 */
    connect() {
      if (isLive()) return;
      try {
        socket = socketFactory(url);
      } catch {
        socket = null;
        return;
      }
      socket.addEventListener('message', (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return; // socket 上什么都可能来，看不懂就忽略
        }
        if (payload) notify(payload);
      });
      socket.addEventListener('close', () => { socket = null; });
      socket.addEventListener('error', () => { /* close 会跟着来 */ });
    },

    /** 沿同一条连接把结果送回。连接没就绪时返回 false，让调用方知道没送出去。 */
    send(message) {
      if (!socket || socket.readyState !== 1) return false;
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
  };
}
