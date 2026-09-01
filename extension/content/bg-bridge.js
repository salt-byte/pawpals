/**
 * content script → service worker 的单向消息桥。
 *
 * 为什么不直接写 chrome.runtime.sendMessage(...).catch()：扩展被重载（开发时
 * 点 ⟳，或版本更新）之后，旧页面里残留的 content script 会失去扩展上下文，
 * 这时 sendMessage 是**同步抛错**的——错误在返回 Promise 之前就抛出来了，
 * .catch() 接不住，于是每次心跳都会留下一条未捕获错误。
 *
 * 心跳丢一次没有后果（下一拍就补上），所以这里一律吞掉，保持页面 console 干净。
 */
export async function sendToBackground(sendMessage, message) {
  try {
    return await sendMessage(message);
  } catch {
    return null;
  }
}
