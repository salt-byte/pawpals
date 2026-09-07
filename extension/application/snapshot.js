/**
 * 页面快照：只做机械可靠的事，把「这是什么框」留给模型。
 *
 * 今天修的缺陷里有八个是启发式在猜页面——标签藏在哪个兄弟节点、哪个 div 是字段
 * 容器、哪段文字是选项、script 内容算不算标签。每换一家表单构建器就要再猜一轮，
 * 而且猜错时是静默的：「简历附件」认不出来，整道「简历先传」的闸就空转了。
 *
 * 所以这里只做三件确定的事：
 *   1. 找到可交互的控件（含没有原生元素、纯 div 模拟的那种）
 *   2. 给每个控件一个跨渲染稳定的句柄
 *   3. 抓它周围的**原文**，不加解释
 *
 * 不给 label、不给 kind——那是猜测，交给模型。它看得懂「* / 姓名 / [输入框]」
 * 这种排布，不需要我们先猜对。
 *
 * 只保留一处代码判断：type=file。文件框永远由代码把关（简历先传、提交前拦截），
 * 这是安全闸，不能建立在模型的判断上。
 */

import { fieldSignature } from './schema.js';
import { gridHeaderFor } from './grid.js';
import { nativeSetValue } from '../act/synthetic.js';

/** 这些标签的文字是代码不是文案，绝不能进快照——否则页面令牌会被送进模型。 */
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);
/** 不需要填写的控件类型。 */
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset']);
/** 像「一个表单字段的容器」的 class，用来圈定抓原文的范围。 */
const FIELD_CONTAINER_HINT = /field|form-?item|form-?group/i;
/** 值区域的 class 特征，用来发现纯 div 模拟的控件。 */
const VALUE_AREA_HINT = /value|combo|select|picker|input|control|upload|checkbox|radio|switch|cascader/i;

const DEFAULT_CONTEXT_LIMIT = 200;
const DEFAULT_MAX_CONTROLS = 200;
const CONTAINER_DEPTH = 5;
/**
 * 抓原文时最多走多少个节点。
 *
 * 扁平结构里每个控件都会往上走到 body，再扫一遍全部兄弟节点——400 个控件就是
 * 十几万次遍历，测试里直接超时。这是今天第四次踩「DOM 遍历没有上限」。
 */
const MAX_TEXT_NODES = 300;

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** 容器里的可见文案。跳过 script/style——那是代码，混进去等于把页面令牌送给模型。 */
function visibleText(container, limit) {
  const parts = [];
  let scanned = 0;
  let length = 0;
  for (const node of container.querySelectorAll('*')) {
    if ((scanned += 1) > MAX_TEXT_NODES) break;
    if (NON_TEXT_TAGS.has(node.tagName)) continue;
    if (node.querySelector('*')) continue;
    const text = tidy(node.textContent);
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
    if (length > limit) break;
  }
  return parts.join(' ').slice(0, limit);
}

/**
 * 控件周围的原文。不做任何"哪段是标签"的判断——只圈范围，不下结论。
 *
 * 向上走到**第一个有文案的祖先**就停。这是机械规则，不是猜测：再往上只会把无关
 * 内容圈进来，而那会让句柄跟着页面别处的变动一起变，稳定性就没了。
 */
/** 标题节点长什么样。和 form.js 用同一套 hint——同一件事不该有两套判断。 */
const LABEL_CLASS_HINT = /label|field-?name|field-?title|form-?item-?label/i;
/** 找标题时最多看多少个同级节点。字段容器只有几个孩子；上限是为了挡住 body。 */
const SIBLING_SCAN_CAP = 50;

/**
 * 取一个节点的文字。
 *
 * visibleText 只扫**后代叶子**，对「自己就是叶子」的标题节点（<div class=
 * "field-name">最高学历</div>）会返回空串。标题恰恰基本都是叶子，所以必须分开处理。
 */
const textOf = (node, limit, cache) => {
  // 同一个容器在一次快照里会被每个控件各扫一遍——400 个 input 都挂在 body 下时
  // 就是 400 × 整棵树。缓存只活在单次快照内，不跨调用，所以页面重渲染不会读到旧值。
  const hit = cache?.get(node);
  if (hit !== undefined) return hit;
  const text = node.firstElementChild ? visibleText(node, limit) : tidy(node.textContent).slice(0, limit);
  cache?.set(node, text);
  return text;
};

/** 安全地 querySelector：适配器选择器将来是服务端下发的不受信数据，可能不合法。 */
function safeQuery(root, selector) {
  if (!selector) return null;
  try { return root.querySelector(selector); } catch { return null; }
}

/**
 * 控件的原文上下文——模型认字段全靠它。
 *
 * 三段式，优先级从精确到宽松：
 *   1. 站点适配器给的标题选择器（第一层，命中已知平台时最准）
 *   2. 带标题类名的节点（通用启发式，和 form.js 同一套 hint）
 *   3. 第一个有文字的祖先（兜底，也是这里原本唯一的做法）
 *
 * 为什么必须有 1、2：原来只有第 3 条，它停在**第一个有文字的祖先**上。简道云
 * 的结构是 .fx-field > [.field-name 「最高学历」, .field-component > [input,
 * .tip 「必填，请如实填写…」]]——input 的父级 .field-component 有文字（那句
 * 提示），于是 context 变成「必填，请如实填写…」，走到不了外面那层真正的标题。
 * 模型因此看到一堆长得一模一样的校验提示，认不出这是哪个字段。
 */
function contextOf(el, limit, labelSelector, cache) {
  // 表格里的格子：标签在列头上，周围一个字都没有。必须先走这条，否则向上找
  // 标题会走到整张子表单的标题、或者行号「1」上——真机上四张经历表因此全空。
  const column = gridHeaderFor(el);
  if (column) {
    // 拼上这张表自己的名字：四张表都有「开始时间」，光给列名分不清是哪张。
    const table = tableLabelOf(el, limit, cache);
    return table ? `${table} · ${column}` : column;
  }

  let fallback = '';
  let container = el.parentElement;
  for (let depth = 0; depth < CONTAINER_DEPTH && container; depth += 1) {
    const hit = safeQuery(container, labelSelector);
    const hitText = hit ? textOf(hit, limit, cache) : '';
    if (hitText) return hitText;

    // 用普通循环、并且封顶：不能 [...container.children] 展开。真实的字段容器
    // 只有几个孩子，而向上走会走到 body——把 body 的几百个孩子每个控件展开一遍，
    // 就是又一次 O(n²)（400 个 input 的用例从 298ms 涨到 1686ms 就是这么来的）。
    const kids = container.children;
    const scan = Math.min(kids.length, SIBLING_SCAN_CAP);
    for (let i = 0; i < scan; i += 1) {
      const node = kids[i];
      if (!LABEL_CLASS_HINT.test(String(node.className || ''))) continue;
      const text = textOf(node, limit, cache);
      if (text) return text;
    }

    // 记下最内层那个有文字的祖先当兜底，但不立刻返回——外面可能还有真正的标题
    if (!fallback) fallback = textOf(container, limit, cache);
    container = container.parentElement;
  }
  return fallback;
}

/**
 * 子表单自己的标题（「获奖经历」「社团干部经历」）。
 *
 * 从格子往上走，找第一个带标题类名、又不在表格内部的节点。找不到就返回空——
 * 只给列名也比给错强。
 */
function tableLabelOf(el, limit, cache) {
  for (let node = el?.parentElement, depth = 0; node && depth < 10; node = node.parentElement, depth += 1) {
    for (const child of node.children) {
      if (!LABEL_CLASS_HINT.test(String(child.className || ''))) continue;
      if (child.contains(el)) continue;
      const text = textOf(child, limit, cache);
      // 列头本身也带 title 类名，用「不包含当前格子」还不够，再挡掉表头区
      if (text && !/^[*＊]/.test(text)) return text;
    }
  }
  return '';
}

const hasValueArea = (container) =>
  [...container.querySelectorAll('*')].some((node) => VALUE_AREA_HINT.test(String(node.className || '')));

/** 纯 div 模拟的控件：字段容器、里面没有原生控件、但有一块放值的地方。 */
function widgetContainers(root) {
  const out = [];
  for (const container of root.querySelectorAll('*')) {
    if (!FIELD_CONTAINER_HINT.test(String(container.className || ''))) continue;
    if (container.querySelector('input, textarea, select')) continue;
    if (!hasValueArea(container)) continue;
    // 只取最外层：.fx-field 里的 .field-name / .field-component 也含 field
    let nested = false;
    for (let node = container.parentElement; node; node = node.parentElement) {
      if (FIELD_CONTAINER_HINT.test(String(node.className || ''))) { nested = true; break; }
    }
    if (!nested) out.push(container);
  }
  return out;
}

/**
 * 快照条目：控件描述 + 它对应的元素。
 *
 * 填写时必须按同一套句柄定位，否则模型按快照作答、填写却按另一套签名找元素，
 * 永远对不上号。所以快照要同时是「采集」和「填写」的唯一来源。
 */
export function snapshotEntries(root = document, {
  contextLimit = DEFAULT_CONTEXT_LIMIT,
  maxControls = DEFAULT_MAX_CONTROLS,
  // 站点适配器给的标题选择器（见 adapters.js）。不给就走通用启发式。
  labelSelector = '',
} = {}) {
  const out = [];
  /** 单次快照内的文本缓存，见 textOf。 */
  const textCache = new Map();

  const natives = [...root.querySelectorAll('input, textarea, select')].filter(
    (el) => !el.disabled && !SKIP_TYPES.has((el.getAttribute('type') || '').toLowerCase())
  );
  for (const el of natives) {
    if (out.length >= maxControls) return out;
    const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
    // 周围没有文案时退回控件自身的元数据。这是机械取值——aria-label / placeholder
    // / name 是元素自己的属性，不是「哪个兄弟节点是标签」那种猜测。真机上 39 个
    // 控件里有 19 个周围抓不到文案，空着等于模型看不见它们。
    const context = contextOf(el, contextLimit, labelSelector, textCache)
      || tidy(el.getAttribute('aria-label'))
      || tidy(el.getAttribute('placeholder'))
      || tidy(el.getAttribute('name'));
    out.push({ el, control: {
      // 句柄不含完整上下文——上下文会随页面别处的改动而变。只取第一段文字做区分，
      // 这是机械取值，不是"这段是标签"的判断。
      handle: fieldSignature({ name: el.getAttribute('name'), id: el.id, type, label: context.split(' ')[0] || '' }),
      type,
      required: el.required || el.getAttribute('aria-required') === 'true',
      options: el.tagName === 'SELECT' ? [...el.options].map((option) => tidy(option.textContent)) : [],
      context,
    } });
  }

  for (const container of widgetContainers(root)) {
    if (out.length >= maxControls) return out;
    const context = contextOf(container.firstElementChild ?? container, contextLimit, labelSelector, textCache);
    out.push({ el: container, control: {
      handle: fieldSignature({ name: '', id: container.id, type: 'widget', label: context.split(' ')[0] || '' }),
      type: 'widget',
      required: [...container.querySelectorAll('[class*="required"]')].some((m) => tidy(m.textContent) === '*'),
      options: [],
      context,
    } });
  }

  return dedupeHandles(out);
}

/**
 * 句柄去重。
 *
 * 真机：帆软那页三个「意向」字段的 name/id 都是空、上下文第一个词又都一样，
 * 于是拿到同一个句柄，模型作答后全被判 ambiguous_signature，过门 0——整条链路
 * 因为句柄不唯一而作废。
 *
 * 撞车的按文档顺序加序号。本来就唯一的不加，保持稳定。
 */
function dedupeHandles(entries) {
  const seen = new Map();
  for (const entry of entries) seen.set(entry.control.handle, (seen.get(entry.control.handle) ?? 0) + 1);
  const used = new Map();
  return entries.map((entry) => {
    const base = entry.control.handle;
    if ((seen.get(base) ?? 0) <= 1) return entry;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { ...entry, control: { ...entry.control, handle: `${base}#${n}` } };
  });
}

/** 只要控件描述，不要元素。给服务端和模型看的就是这个。 */
export function snapshotControls(root = document, opts = {}) {
  return snapshotEntries(root, opts).map((entry) => entry.control);
}

/** 按句柄反查元素。找不到返回 null——绝不退而求其次去猜别的控件。 */
export function elementForHandle(root = document, handle, opts = {}) {
  // opts 必须和采集时用的一致（尤其 labelSelector）：句柄由 context 派生，两边
  // 用不同的选项就会算出两套句柄，模型作答后一个都定位不到。
  const hit = snapshotEntries(root, opts).find((entry) => entry.control.handle === handle);
  return hit ? hit.el : null;
}

/**
 * 按快照句柄填写。
 *
 * 快照必须同时是采集和填写的来源，否则模型按快照的句柄作答、填写却按另一套签名
 * 定位，永远对不上号。
 *
 * 三类分流：
 *   原生输入框  直接写值并派发 input/change
 *   widget      交回上层用驱动器点开面板选中——这里不硬填
 *   文件框      永远跳过，文件由独立的 upload 任务处理
 */
export function fillByHandle(root = document, values = [], opts = {}) {
  const filled = [];
  const skipped = [];
  const widgets = [];
  if (!Array.isArray(values) || values.length === 0) return { filled, skipped, widgets };

  // 同上：采集和填写必须用同一套选项，否则句柄对不上。
  const entries = snapshotEntries(root, opts);
  for (const item of values) {
    const hit = entries.find((entry) => entry.control.handle === item.signature);
    if (!hit) { skipped.push({ signature: item.signature, reason: 'not_found' }); continue; }
    if (hit.control.type === 'widget') { widgets.push(item); continue; }
    if (hit.control.type === 'file') { skipped.push({ signature: item.signature, reason: 'file_input' }); continue; }
    if (typeof item.value !== 'string') { skipped.push({ signature: item.signature, reason: 'invalid_value' }); continue; }

    try {
      nativeSetValue(hit.el, item.value);
      hit.el.dispatchEvent(new Event('input', { bubbles: true }));
      hit.el.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push(item.signature);
    } catch (error) {
      skipped.push({ signature: item.signature, reason: 'set_failed', error: String(error?.message || error) });
    }
  }
  return { filled, skipped, widgets };
}


/**
 * 快照里的 widget 及其容器元素，直接喂给 probeWidgets。
 *
 * 为什么必须有它：probe 原先走 collectWidgetTargets（form.js 的签名），而
 * inspect 和 fill 走快照句柄——两套寻址。探回来的选项按签名标记，字段表按句柄
 * 索引，于是选项**并不回字段表**，模型永远在不知道有哪些选项的情况下作答。
 * 快照是采集和填写的唯一来源，探测也必须用同一套。
 *
 * 形状对齐 probeWidgets 的 targets：{ field: { signature, label }, container }。
 */
export function widgetTargets(root = document, opts = {}) {
  return snapshotEntries(root, opts)
    .filter((entry) => entry.control.type === 'widget')
    .map((entry) => ({
      field: { signature: entry.control.handle, label: entry.control.context },
      container: entry.el,
    }));
}
