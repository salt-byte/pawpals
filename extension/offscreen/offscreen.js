import { createSocketHost } from './socket-host.js';
import { SERVER_BASE } from '../background/session-client.js';

/**
 * 常驻的服务端连接。
 *
 * 这个文档不受 service worker 的生命周期管辖，所以连接不会跟着进程一起断——
 * 今天那五个保活补丁想解决的正是这件事（详见 socket-host.js 顶部）。
 *
 * offscreen 拿不到 chrome.tabs，所以它只做两件事：把服务端推来的任务转发给
 * service worker（消息事件顺带把它唤醒），把 service worker 给的结果送回服务端。
 */
const SOCKET_URL = `${SERVER_BASE.replace(/^http/, 'ws')}/ws/official`;

let hostSocket;
hostSocket = createSocketHost({
  url: SOCKET_URL,
  socketFactory: (url) => new WebSocket(url),
  notify: (payload) => {
    // 先回一条进度：offscreen 和 service worker 的控制台我都读不到，只有服务端
    // 日志能看见。没有这条就分不清「任务没到 offscreen」和「offscreen 转发了但
    // service worker 没醒」。
    if (payload?.task?.id) {
      hostSocket.send({ type: 'progress', id: payload.task.id, progress: { stage: 'offscreen_received' } });
    }
    // 转发给 service worker。它没在跑的话，这条消息本身应该把它拉起来。
    chrome.runtime.sendMessage({ type: 'OFFICIAL_SOCKET_MESSAGE', payload })
      .then(() => {
        if (payload?.task?.id) hostSocket.send({ type: 'progress', id: payload.task.id, progress: { stage: 'sw_acked' } });
      })
      .catch((error) => {
        if (payload?.task?.id) {
          hostSocket.send({ type: 'progress', id: payload.task.id, progress: { stage: 'sw_unreachable', message: String(error?.message || error).slice(0, 80) } });
        }
      });
  },
});

hostSocket.connect();
// 服务端重启时连接会断，这里负责重连；offscreen 自己不会死，所以这个定时器是可靠的。
setInterval(() => hostSocket.connect(), 5000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OFFICIAL_SOCKET_SEND') return false;
  sendResponse({ ok: hostSocket.send(message.payload) });
  return false;
});
