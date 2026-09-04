import { widgetContainerFor } from './form.js';
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

/**
 * 选项面板的容器长什么样。
 *
 * 认面板、而不是认选项——真机根因：简道云级联控件的选项是**完全没有 class 的
 * <span>**（SPAN. → "产品类" / "研发类"），靠 class 认选项一个都匹配不上，
 * 「意向岗位大类」这类必填字段因此一直填不上。面板容器倒是有类名，而且两种
 * 控件用的是同一套（x-popup / x-combo-dropdown）。
 */
const PANEL_SELECTOR = '[class*="dropdown"],[class*="Dropdown"],[class*="popup"],[class*="Popup"],[class*="popper"],[class*="Popper"],[class*="menu"],[class*="Menu"],[class*="options"],[class*="select-panel"]';
/** 面板里这些标签不是选项：输入框、按钮之类。 */
const NON_OPTION_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SCRIPT', 'STYLE', 'SVG', 'PATH']);

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export function createWidgetDriver({ click, wait, elementAtCenter, isVisible, root = document }) {
  /**
   * 当前可见的、像选项的元素。用于点开前后求差。
   *
   * 必须先用原生选择器把候选集缩小，不能遍历 querySelectorAll('*')：isVisible
   * 要读 getBoundingClientRect，对每个元素调一次等于强制布局。真机上帆软那页
   * 几千个元素，每个 widget 要求差 4 次、15 个 widget 就是十几万次强制布局，
   * 渲染进程直接卡死——probe 任务 60 秒都回不来。
   */
  /**
   * 可见的选项面板，只取最外层。
   *
   * 面板往往层层嵌套（.x-popup 里还有 .x-combo-dropdown-list），两层都匹配
   * PANEL_SELECTOR，不去重就会把同一批选项数两遍。
   */
  const panelNodes = () => {
    const all = [...root.querySelectorAll(PANEL_SELECTOR)].filter(isVisible);
    const set = new Set(all);
    return all.filter((panel) => {
      for (let node = panel.parentElement; node; node = node.parentElement) {
        if (set.has(node)) return false;
      }
      return true;
    });
  };

  /** 面板里有文字的叶子节点就是选项。不看它们自己的 class——很多根本没有。 */
  const optionsIn = (panels) => {
    const out = [];
    for (const panel of panels) {
      for (const el of panel.querySelectorAll('*')) {
        if (NON_OPTION_TAGS.has(el.tagName)) continue;
        if (el.querySelector('*')) continue;
        if (!isVisible(el)) continue;
        const text = tidy(el.textContent);
        if (text) out.push({ el, text });
      }
    }
    return out;
  };

  /** 收起面板：先按 Esc，再点一下 body，两条路都试。 */
  async function dismiss() {
    try {
      root.body?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      root.body?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } catch { /* 收不起来不影响读到的结果 */ }
    await wait(120);
  }

  /** 点一次触发器，返回新出现的面板里的选项。 */
  async function clickAndDiff(container, before) {
    const trigger = elementAtCenter(container);
    if (!trigger) return [];
    await click(trigger);
    await wait(250);
    const fresh = panelNodes().filter((panel) => !before.has(panel));
    return optionsIn(fresh);
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
    const fresh = await clickAndDiff(container, new Set(panelNodes()));
    if (fresh.length > 0) return fresh;
    return clickAndDiff(container, new Set(panelNodes()));
  }

  return {
    /** 点开、读出选项、收起。用于让模型知道这个框有哪些合法值。 */
    async probeOptions(container) {
      const fresh = await open(container);
      const options = fresh.map((item) => item.text).filter(Boolean);
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

      const options = fresh.map((item) => item.text);
      const hit = fresh.find((item) => item.text === wanted);
      if (!hit) {
        await dismiss();
        return { ok: false, reason: 'option_not_found', options };
      }

      await click(hit.el);
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

export { PANEL_SELECTOR };

/**
 * 把一批值交给 widget 驱动器。
 *
 * fillApplicationFields 遇到 widget 会以 unsupported_widget 跳过——那套按
 * elements[index] 定位的办法对没有原生控件的字段用不上。这里接住这些值，用
 * 容器 + 驱动器把它们点进去。
 *
 * 驱动器的失败原因原样带出（option_not_found 会附上真实可选项），让上游能告诉
 * 用户「这个框我填不了，可选的是这几个」，而不是笼统地说没填上。
 */
export async function applyWidgetValues(root = document, values = [], { driver, findContainer } = {}) {
  const filled = [];
  const skipped = [];
  if (!Array.isArray(values) || values.length === 0 || !driver) return { filled, skipped };

  const locate = findContainer ?? ((signature) => widgetContainerFor(root, signature));

  for (const item of values) {
    const container = locate(item.signature);
    if (!container) { skipped.push({ signature: item.signature, reason: 'not_found' }); continue; }
    try {
      const result = await driver.selectOption(container, item.value);
      if (result?.ok) filled.push(item.signature);
      else skipped.push({ signature: item.signature, reason: result?.reason || 'unknown', options: result?.options });
    } catch (error) {
      skipped.push({ signature: item.signature, reason: 'driver_error', error: String(error?.message || error) });
    }
  }
  return { filled, skipped };
}

/**
 * 逐个探测 widget 的可选项，带边界。
 *
 * 真机实测：单个 widget 探测约 2.8 秒——级联控件（意向岗位大类这类）点开时要
 * 向服务器拉选项，快不了。帆软那页 15 个 widget 全探一遍要 42 秒，任务直接
 * 超时、队列被堵死。
 *
 * 所以给两个边界：
 *   signatures  只探服务端真正要的那几个，不要每次全量
 *   budgetMs    超预算就停，返回已探到的并标记 partial
 *
 * 宁可返回一半并说清楚是一半，也不要让整个任务超时——超时的任务会卡在队首，
 * 后面所有投递都动不了。
 */
export async function probeWidgets(targets = [], { driver, signatures, budgetMs = 20000, maxOptions = 60, now = () => Date.now() } = {}) {
  const probed = [];
  if (!driver || targets.length === 0) return { probed, partial: false };

  const wanted = Array.isArray(signatures) && signatures.length ? new Set(signatures) : null;
  const list = wanted ? targets.filter((t) => wanted.has(t.field.signature)) : targets;

  const startedAt = now();
  let partial = false;
  for (const { field, container } of list) {
    if (now() - startedAt >= budgetMs) { partial = true; break; }
    try {
      const all = await driver.probeOptions(container);
      // 截断超长列表。真机上帆软的「本科学校」是全国高校下拉，探回来 2604 个，
      // 两个学校字段合起来 5208 个——塞进 LLM prompt 直接把请求撑爆。这类字段
      // 本质是「可搜索」而不是「可枚举」，完整列表对模型没有意义。
      probed.push({
        signature: field.signature, label: field.label,
        options: all.slice(0, maxOptions),
        optionCount: all.length,
        truncated: all.length > maxOptions,
      });
    } catch (error) {
      probed.push({ signature: field.signature, label: field.label, options: [], error: String(error?.message || error) });
    }
  }
  return { probed, partial };
}

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

