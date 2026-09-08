import { widgetContainerFor } from './form.js';
import { createAdapterRegistry } from './adapters.js';
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
/**
 * 一个面板里最多取多少个选项，以及最多走多少个节点。
 *
 * 真机上帆软的学校下拉有 2604 个选项，不设上限的话光是遍历子树就让 probe 任务
 * 180 秒回不来。上限之外的部分由 probeWidgets 标成 truncated——那种字段本来
 * 就是「可搜索」而非「可枚举」，完整列表没有意义。
 */
const MAX_OPTIONS_PER_PANEL = 300;
const MAX_NODES_PER_PANEL = 2000;

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

export function createWidgetDriver({ click, type, wait, elementAtCenter, isVisible, root = document,
  // 站点适配器可以收窄它（见 adapters.js）。简道云的面板是 .x-popup，用通用那
  // 一长串会连带匹配到无关容器，反而更差。没传就是原来的通用行为。
  panelSelector = PANEL_SELECTOR } = {}) {
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
    const all = [...root.querySelectorAll(panelSelector || PANEL_SELECTOR)].filter(isVisible);
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
      let scanned = 0;
      for (const el of panel.querySelectorAll('*')) {
        if (out.length >= MAX_OPTIONS_PER_PANEL || (scanned += 1) > MAX_NODES_PER_PANEL) break;
        if (NON_OPTION_TAGS.has(el.tagName)) continue;
        if (el.querySelector('*')) continue;
        // 特意不逐个做可见性检查：面板自身已经确认可见，对每个选项读一次
        // getBoundingClientRect 等于强制布局——2604 个选项的下拉会把整个任务拖死。
        const text = tidy(el.textContent);
        if (text) out.push({ el, text });
      }
    }
    return out;
  };

  /** 面板里的搜索框。有它就能搜而不是枚举。 */
  const searchBoxIn = (panels) => {
    for (const panel of panels) {
      const box = panel.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea');
      if (box) return box;
    }
    return null;
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
    const outcome = await click(trigger);
    await wait(250);
    let fresh = panelNodes().filter((panel) => !before.has(panel));

    // 合成点击没让面板出来时，用调用方提供的兜底再点一次（真机上是 CDP 派发真实
    // 事件）。只在确实没反应时才走，因为它会让 Chrome 挂调试横幅。
    if (fresh.length === 0 && typeof outcome?.cdpFallback === 'function') {
      await outcome.cdpFallback();
      await wait(350);
      fresh = panelNodes().filter((panel) => !before.has(panel));
    }
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

      let candidates = fresh;
      let hit = candidates.find((item) => item.text === wanted);

      // 面板带搜索框时先打字过滤：帆软的「本科学校」是全国高校下拉，2604 个选项，
      // 枚举既慢（光渲染就几秒）又塞不进 prompt，而面板 class 里明明写着
      // has-search。搜一下一步到位，也不必事先把这类字段探成 truncated。
      if (!hit && type) {
        const box = searchBoxIn(panelNodes());
        if (box) {
          await type(box, wanted);
          // 等结果真的回来，别只等一个固定时长：面板里还挂着「搜索中...」就说明
          // 还没到，这时候读只会读到旧内容或占位符。
          for (let i = 0; i < SEARCH_WAIT_MAX; i += 1) {
            await wait(SEARCH_WAIT_STEP_MS);
            candidates = optionsIn(panelNodes());
            const loading = candidates.some((item) => LOADING_MARK.test(item.text));
            hit = candidates.find((item) => item.text === wanted);
            if (hit || !loading) break;
          }
        }
      }

      const options = candidates.map((item) => item.text);
      if (!hit) {
        await dismiss();
        return { ok: false, reason: 'option_not_found', options };
      }

      // 选中这一下要「可信」：合成事件能让显示变，但页面内部的数据模型不提交。
      // 真机对照过——合成事件选完「意向岗位大类=产品类」，显示对了、读回也过了，
      // 但依赖它的「意向岗位」始终没有选项；换成 CDP 派发的真实事件，当场解锁出
      // 「全选/产品经理/产品运营」。
      //
      // 只有这一下用 CDP：打开面板、读选项用合成事件是好的（真机验证过），全程
      // 挂调试器反而慢到单字段超时——探 15 个只探完 2 个。
      await click(hit.el, { trusted: true });
      await wait(400);

      // 回读：值真的落到控件上了才算成功
      const applied = tidy(container.textContent).includes(wanted);
      // 成功也要收起浮层。多选控件（combocheck）选完不会自己关，开着的话它那些
      // 选项会被下一次快照当成表单字段采进去——真机上「语言特长」的 11 个选项
      // 就这么变成了 11 个「已填好的字段」，40 个字段虚报成 52 个。
      await dismiss();
      if (!applied) return { ok: false, reason: 'value_not_applied', options };
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
/** 单个控件最多花多久。超了就跳过，别让一个慢控件吃掉整轮预算。 */
const DEFAULT_PER_FIELD_MS = 8000;

/**
 * 「面板开了，但里面只有一句空状态」的样子。
 *
 * 真机：填完「意向岗位大类 = 产品类」后再探「意向岗位」，拿回来的是 1 个选项
 * 「没有可选择的数据」。这有两种解释，光看一次读不出来——选项是异步拉的、我们
 * 只等 350ms 读太早；还是父级的值只是显示上去了、页面内部的数据模型没更新。
 *
 * 与其推理，不如让探测自己分辨：像空状态就多等一会儿重读。重读后有了 → 异步；
 * 还是空 → 父级没生效，而且 emptyState 会把面板原文带回服务端，不用再猜。
 */
const EMPTY_STATE = /^(没有可选择的数据|暂无数据|无数据|无可选项|加载中|loading|no data|no options)$/i;

/**
 * 「结果还在路上」的样子。
 *
 * 真机决定性证据：给「本科学校」搜「北京电影学院」，返回的选项是
 *   ["可多选","可多选","可多选","研究生","搜索中..."]
 * ——「搜索中...」说明还在加载，而我们打完字只等 400ms 就去读了，读到的当然
 * 找不到目标。这解释了「之前能搜、后来不能」：不是坏了，是一直有竞态，之前碰巧
 * 赢了。碰运气的东西必须变成等待条件。
 */
const LOADING_MARK = /^(搜索中|加载中|loading|正在搜索)[.．…]*$/i;
const SEARCH_WAIT_STEP_MS = 400;
const SEARCH_WAIT_MAX = 8;
const DEFAULT_EMPTY_RETRY_MS = 1500;

export async function probeWidgets(targets = [], { driver, signatures, budgetMs = 20000, maxOptions = 60, perFieldMs = DEFAULT_PER_FIELD_MS, emptyRetryMs = DEFAULT_EMPTY_RETRY_MS, now = () => Date.now(), onProgress } = {}) {
  const probed = [];
  if (!driver || targets.length === 0) return { probed, partial: false };

  const wanted = Array.isArray(signatures) && signatures.length ? new Set(signatures) : null;
  const list = wanted ? targets.filter((t) => wanted.has(t.field.signature)) : targets;

  const startedAt = now();
  let partial = false;
  const report = (progress) => { try { onProgress?.(progress); } catch { /* 进度上报不能打断填写 */ } };
  for (const [index, { field, container }] of list.entries()) {
    if (now() - startedAt >= budgetMs) { partial = true; break; }
    report({ stage: 'probing', completed: index, total: list.length, label: field.label, signature: field.signature });
    try {
      // 单字段超时：真机上帆软那两个学校下拉各有 2604 个选项，光渲染就要几秒，
      // 只有总预算的话它们会吃掉全部时间，后面十几个字段一个都探不到。
      const TIMEOUT = Symbol('probe-timeout');
      const readOnce = async () => {
        let timer;
        return Promise.race([
          driver.probeOptions(container),
          new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), perFieldMs); }),
        ]).finally(() => clearTimeout(timer));
      };

      let all = await readOnce();
      // 面板里只有一句空状态：等一会儿重读。级联下拉的选项常常是点开后才去拉的。
      let emptyState = '';
      if (Array.isArray(all) && all.length === 1 && EMPTY_STATE.test(String(all[0]).trim())) {
        emptyState = String(all[0]).trim();
        await new Promise((r) => setTimeout(r, emptyRetryMs));
        const retried = await readOnce();
        if (Array.isArray(retried) && !(retried.length === 1 && EMPTY_STATE.test(String(retried[0]).trim()))) {
          all = retried;
          emptyState = '';
        } else {
          // 重读还是空：不是异步的问题。如实报空，并把面板原文带回去。
          all = [];
        }
      }

      if (all === TIMEOUT) {
        probed.push({ signature: field.signature, label: field.label, options: [], optionCount: 0, truncated: false, timedOut: true });
        report({ stage: 'probing', completed: index + 1, total: list.length, label: field.label, signature: field.signature, timedOut: true });
        continue;
      }
      // 截断超长列表。真机上帆软的「本科学校」是全国高校下拉，探回来 2604 个，
      // 两个学校字段合起来 5208 个——塞进 LLM prompt 直接把请求撑爆。这类字段
      // 本质是「可搜索」而不是「可枚举」，完整列表对模型没有意义。
      probed.push({
        signature: field.signature, label: field.label,
        options: all.slice(0, maxOptions),
        optionCount: all.length,
        truncated: all.length > maxOptions,
        timedOut: false,
        ...(emptyState ? { emptyState } : {}),
      });
      report({ stage: 'probing', completed: index + 1, total: list.length, label: field.label, signature: field.signature });
    } catch (error) {
      probed.push({ signature: field.signature, label: field.label, options: [], error: String(error?.message || error) });
      report({ stage: 'probing', completed: index + 1, total: list.length, label: field.label, signature: field.signature, error: true });
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
const adapters = createAdapterRegistry();

/** 当前页面命中的站点适配器给出的面板选择器；没命中就是通用那串。 */
function pageSelectors(root) {
  try {
    return adapters.selectorsFor(root?.location?.href || '');
  } catch {
    return { provider: 'generic', panel: PANEL_SELECTOR };
  }
}

export function createPageWidgetDriver({ click, type, root = document, panelSelector } = {}) {
  const valueAreaOf = (container) =>
    [...container.querySelectorAll('*')].find(
      (node) => VALUE_AREA_HINT.test(String(node.className || '')) && node.getBoundingClientRect().height > 0
    ) || container;

  return createWidgetDriver({
    click,
    type,
    root,
    // 适配器命中就用它的面板选择器（0 延迟、0 token 的第一层），没命中退回通用
    panelSelector: panelSelector || pageSelectors(root).panel,
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
