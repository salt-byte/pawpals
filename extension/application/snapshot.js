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
function contextOf(el, limit) {
  let container = el.parentElement;
  for (let depth = 0; depth < CONTAINER_DEPTH && container; depth += 1) {
    const text = visibleText(container, limit);
    if (text) return text;
    if (FIELD_CONTAINER_HINT.test(String(container.className || ''))) return text;
    container = container.parentElement;
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
export function snapshotEntries(root = document, { contextLimit = DEFAULT_CONTEXT_LIMIT, maxControls = DEFAULT_MAX_CONTROLS } = {}) {
  const out = [];

  const natives = [...root.querySelectorAll('input, textarea, select')].filter(
    (el) => !el.disabled && !SKIP_TYPES.has((el.getAttribute('type') || '').toLowerCase())
  );
  for (const el of natives) {
    if (out.length >= maxControls) return out;
    const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
    const context = contextOf(el, contextLimit);
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
    const context = contextOf(container.firstElementChild ?? container, contextLimit);
    out.push({ el: container, control: {
      handle: fieldSignature({ name: '', id: container.id, type: 'widget', label: context.split(' ')[0] || '' }),
      type: 'widget',
      required: [...container.querySelectorAll('[class*="required"]')].some((m) => tidy(m.textContent) === '*'),
      options: [],
      context,
    } });
  }

  return out;
}

/** 只要控件描述，不要元素。给服务端和模型看的就是这个。 */
export function snapshotControls(root = document, opts = {}) {
  return snapshotEntries(root, opts).map((entry) => entry.control);
}

/** 按句柄反查元素。找不到返回 null——绝不退而求其次去猜别的控件。 */
export function elementForHandle(root = document, handle) {
  const hit = snapshotEntries(root).find((entry) => entry.control.handle === handle);
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
export function fillByHandle(root = document, values = []) {
  const filled = [];
  const skipped = [];
  const widgets = [];
  if (!Array.isArray(values) || values.length === 0) return { filled, skipped, widgets };

  const entries = snapshotEntries(root);
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

