/**
 * 驱动纯 div 模拟的下拉/多选控件。
 *
 * 这类控件（简道云、antd、element-ui）没有原生 input/select，也没有 ARIA role，
 * 值只能靠「点开面板 → 点选项」来设。
 *
 * 真机在帆软秋招页上确认过两件事：
 *   1. 合成事件是有效的——不需要 chrome.debugger，也就不用挂那条「正在调试此
 *      浏览器」的横幅。之前两次失败是点错了元素（点在外层容器上），不是可信性
 *      问题。
 *   2. 必须点「控件中心点上最顶层的那个元素」。外层的 .field-component /
 *      .x-combo 都不响应，真正带监听的是最内层那个。用命中测试来找，不绑定
 *      任何一家厂商的 class。
 *
 * 选项面板是点开时才渲染的，而且渲染在别处（portal）。所以用「点开前后可见元素
 * 求差」来定位它，同样不依赖 class 名。
 */

/** 选项条目长什么样。求差之后再按这个筛，避免把整个面板外壳也算进去。 */
const OPTION_HINT = /option|item|cell|choice/i;
const PANEL_HINT = /dropdown|popup|popper|menu|select-panel|options/i;

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export function createWidgetDriver({ click, wait, elementAtCenter, isVisible, root = document }) {
  /** 当前可见的、像选项的元素。用于点开前后求差。 */
  const optionNodes = () =>
    [...root.querySelectorAll('*')].filter(
      (el) => OPTION_HINT.test(String(el.className || '')) && isVisible(el) && !el.querySelector('*')
    );

  /** 收起面板：先按 Esc，再点一下 body，两条路都试。 */
  async function dismiss() {
    try {
      root.body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      root.body?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } catch { /* 收不起来不影响读到的结果 */ }
    await wait(120);
  }

  /** 点一次触发器，返回相对 before 新出现的选项元素。 */
  async function clickAndDiff(container, before) {
    const trigger = elementAtCenter(container);
    if (!trigger) return [];
    await click(trigger);
    await wait(250);
    return optionNodes().filter((el) => !before.has(el));
  }

  /**
   * 点开控件，返回新出现的选项元素。调用方读完要自己 dismiss()。
   *
   * 会点第二次：页面上已经开着别的控件的面板时，第一次点击往往被「点击外部就
   * 关闭」的逻辑吃掉，只关掉了别人的面板，自己没展开。真机在帆软页上就是这么
   * 失败的——连续探测四个字段，只有第二个成功。
   *
   * 收起面板这件事在那个页面上不可靠（Esc、点 body、再点触发器都试过），所以
   * 不去依赖它，改成让展开这一侧对残留状态免疫。最多点两次，不无限重试。
   */
  async function open(container) {
    const fresh = await clickAndDiff(container, new Set(optionNodes()));
    if (fresh.length > 0) return fresh;
    return clickAndDiff(container, new Set(optionNodes()));
  }

  return {
    /** 点开、读出选项、收起。用于让模型知道这个框有哪些合法值。 */
    async probeOptions(container) {
      const fresh = await open(container);
      const options = fresh.map((el) => tidy(el.textContent)).filter(Boolean);
      await dismiss();
      return options;
    },

    /**
     * 选中一个值。
     *
     * 三种失败都如实上报，绝不谎报成功：面板没展开、选项里没有这个值、点了但
     * 值没落到控件上（页面把这次点击吃掉了）。谎报「已填写」比填不上更糟——
     * 用户会带着空的必填项去提交。
     */
    async selectOption(container, value) {
      const wanted = tidy(value);
      const fresh = await open(container);
      if (fresh.length === 0) {
        await dismiss();
        return { ok: false, reason: 'panel_did_not_open' };
      }

      const options = fresh.map((el) => tidy(el.textContent));
      const hit = fresh.find((el) => tidy(el.textContent) === wanted);
      if (!hit) {
        await dismiss();
        return { ok: false, reason: 'option_not_found', options };
      }

      await click(hit);
      await wait(250);

      // 回读：值真的落到控件上了才算成功
      const applied = tidy(container.textContent).includes(wanted);
      if (!applied) {
        await dismiss();
        return { ok: false, reason: 'value_not_applied', options };
      }
      return { ok: true, value: wanted };
    },
  };
}

export { PANEL_HINT };

/** 值区域的 class 特征。与 form.js 里那份保持一致。 */
const VALUE_AREA_HINT = /value|combo|select|picker|input|control|upload|checkbox|radio|switch|cascader/i;

/**
 * 真实页面上的接缝实现。
 *
 * elementAtCenter 必须先 scrollIntoView：elementFromPoint 只对**视口内**的坐标
 * 有效，控件在滚动区外时会命中别的元素或返回 null。真机上这一条决定成败——
 * 加之前只有恰好在屏幕上的两个字段能探测成功。
 */
export function createPageWidgetDriver({ click, root = document } = {}) {
  const valueAreaOf = (container) =>
    [...container.querySelectorAll('*')].find(
      (node) => VALUE_AREA_HINT.test(String(node.className || '')) && node.getBoundingClientRect().height > 0
    ) || container;

  return createWidgetDriver({
    click,
    root,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isVisible: (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0,
    elementAtCenter: (container) => {
      const area = valueAreaOf(container);
      area.scrollIntoView({ block: 'center' });
      const box = area.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return area;
      return root.elementFromPoint(cx, cy) || area;
    },
  });
}

