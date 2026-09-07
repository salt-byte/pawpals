/**
 * 用 chrome.debugger 注入真实输入事件。
 *
 * 读了 Claude in Chrome 的实现（v1.0.91）：它的点击和键盘走的是
 * chrome.debugger.attach + Input.dispatchMouseEvent / dispatchKeyEvent，而不是
 * 合成事件。代价是 Chrome 会强制显示「XX 已开始调试此浏览器」的横幅；好处是
 * 事件 isTrusted，任何页面都拦不住。
 *
 * 我们的合成事件在简道云上验证过可用，所以 CDP 的定位是**兜底**——合成事件不
 * 生效时才上。因此挂载必须是懒的、用完即摘：那条横幅只该在真正操作的那几秒
 * 出现，不能一直挂在用户眼前。
 *
 * chrome.debugger 只能在 service worker / 扩展页面里用，content script 拿不到。
 * 所以 content script 负责算出视口坐标，实际派发在这里。
 */
export function createCdpInput({ debuggerApi }) {
  /** 已挂载的标签页。挂载是有代价的（横幅），所以要记账，用完摘掉。 */
  const attached = new Set();

  async function ensureAttached(tabId) {
    if (attached.has(tabId)) return true;
    try {
      await debuggerApi.attach({ tabId }, '1.3');
      attached.add(tabId);
      return true;
    } catch {
      // 挂载失败不留脏状态：别的调试器占着、或用户拒绝，下次还要能重试
      attached.delete(tabId);
      return false;
    }
  }

  const send = (tabId, method, params) => debuggerApi.sendCommand({ tabId }, method, params);

  return {
    /** 在视口坐标上点一下。返回是否真的派发了。 */
    async click(tabId, { x, y }) {
      if (!(await ensureAttached(tabId))) return false;
      const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
      try {
        await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none', clickCount: 0 });
        await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
        await send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * 往当前焦点里输入文字。
     *
     * 用 insertText 而不是逐字模拟按键：搜索框只关心最终值和 input 事件，逐字
     * 派发既慢又容易被输入法逻辑打断。
     */
    async type(tabId, text) {
      if (!(await ensureAttached(tabId))) return false;
      try {
        await send(tabId, 'Input.insertText', { text: String(text ?? '') });
        return true;
      } catch {
        return false;
      }
    },

    /** 摘掉调试器。没挂过的标签页调用它不出错。 */
    async release(tabId) {
      if (!attached.has(tabId)) return;
      attached.delete(tabId);
      try {
        await debuggerApi.detach({ tabId });
      } catch {
        // 标签页可能已经关了
      }
    },
  };
}
