import { normaliseField } from './schema.js';

const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION']);
/**
 * 这些标签的 textContent 是代码不是文案，绝不能当字段标签。
 *
 * 真机在帆软秋招页上把 <script> 里的 window.jdy_access_token = "..." 当成了
 * 一个字段的标签——标签会进签名、上报给服务端、再进 LLM prompt，等于把页面
 * 的访问令牌顺着链路泄出去。
 */
const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME']);
/** 标签最长取这么多字——再长就不是标签，是说明文字。 */
const LABEL_MAX = 40;
/** 往上找容器的层数上限。再高就会取到整个表单区块的标题。 */
const CONTAINER_DEPTH = 5;

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** 只有标点或必填星号的文字不算标签。 */
const isLabelish = (text) => Boolean(text) && !/^[\s*·:：)(（）\-—|]+$/.test(text);

/** class 里带这些词的节点，多半就是字段名。 */
const LABEL_CLASS_HINT = /label|field-?name|field-?title|form-?item-?label/i;

/**
 * 标签和它的输入框之间不能隔着另一个输入框。
 *
 * 扁平 DOM 里往上找容器很容易找到 body，于是一个没有标签的框会继承隔壁字段的
 * 标签——单测里 email 框就这样拿到了「简历附件」。签名因此变形，填写会定位失败；
 * 更糟的是分类可能被带偏（一个文本框被当成简历）。
 */
function crossesAnotherControl(leaf, el, node) {
  for (const control of node.querySelectorAll('input, textarea, select')) {
    if (control === el) continue;
    const afterLeaf = (leaf.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const beforeEl = (control.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (afterLeaf && beforeEl) return true;
  }
  return false;
}

/** 收集容器里所有"像标签"的叶子节点。 */
function labelLeaves(node) {
  const leaves = [];
  for (const candidate of node.querySelectorAll('*')) {
    if (CONTROL_TAGS.has(candidate.tagName) || NON_TEXT_TAGS.has(candidate.tagName)) continue;
    if (candidate.querySelector('*')) continue; // 只看叶子节点
    const text = tidy(candidate.textContent).split('\n')[0];
    if (isLabelish(text)) leaves.push({ el: candidate, text: text.slice(0, LABEL_MAX) });
  }
  return leaves;
}

/**
 * 容器式标签兜底。
 *
 * 国内的表单构建器（简道云、金数据这类）不用 <label>：标签是同一个容器里的
 * 兄弟节点，必填是一个单独的 * 元素。真机在帆软秋招页（简道云）上实测，24 个
 * 字段的 label 全是空的，连简历附件都没认出来，「简历先传」那道闸整个失效。
 *
 * 从控件往上逐层找，每层里按两条规则挑：
 *   1. class 带 label / field-name 这类语义的节点——最可靠
 *   2. 否则取**文档顺序上排在控件之前、离得最近**的那段文字（标签在输入框前
 *      面是通行写法）
 *
 * 第 1 条是真机逼出来的：简历附件那个 file 输入被包在上传组件里，容器里第一段
 * 文字是按钮上的「选择」，真正的字段名在更外层的 .field-name 上。
 *
 * 页面标题一律排除：往上找过头时会取到整页的大标题，24 个字段里曾有 5 个被填
 * 成「帆软2027届秋季校招招聘」。
 */
function containerLabel(el) {
  const pageTitle = tidy(typeof document !== 'undefined' ? document.title : '');
  const usable = (text) => text && (!pageTitle || text !== pageTitle);

  const ancestors = [];
  for (let node = el.parentElement, depth = 0; depth < CONTAINER_DEPTH && node; depth += 1, node = node.parentElement) {
    ancestors.push(node);
  }

  // 第一遍：所有层级里找带语义 class 的节点。必须先扫完所有层级再回退，否则
  // 上传组件这类内层容器会用它自己的按钮文字（「选择」）盖住外层真正的字段名。
  for (const node of ancestors) {
    const hinted = labelLeaves(node).find(
      (leaf) => LABEL_CLASS_HINT.test(String(leaf.el.className || '')) && usable(leaf.text)
        && !crossesAnotherControl(leaf.el, el, node)
    );
    if (hinted) return hinted.text;
  }

  // 第二遍：就近取控件前面那一段文字
  for (const node of ancestors) {
    const preceding = labelLeaves(node).filter(
      (leaf) => usable(leaf.text) && (el.compareDocumentPosition(leaf.el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
        && !crossesAnotherControl(leaf.el, el, node)
    );
    if (preceding.length) return preceding[preceding.length - 1].text;
  }
  return '';
}

function labelFor(el) {
  const explicit = el.id
    ? [...document.querySelectorAll('label')].find((label) => label.htmlFor === el.id)?.textContent
    : '';
  const standard = tidy(explicit || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '');
  return standard || containerLabel(el);
}

/**
 * 是否必填。原生 required / aria-required 之外，还认容器里的 * 标记——国内
 * 表单大多用自定义校验，不写原生 required。
 */
function requiredFor(el) {
  if (el.required || el.getAttribute('aria-required') === 'true') return true;
  let node = el.parentElement;
  for (let depth = 0; depth < CONTAINER_DEPTH && node; depth += 1, node = node.parentElement) {
    for (const marker of node.querySelectorAll('[class*="required"]')) {
      if (tidy(marker.textContent) === '*') return true;
    }
  }
  return false;
}

/** 像"一个表单字段的容器"的 class。覆盖简道云 fx-field、antd form-item、element-ui。 */
const FIELD_CONTAINER_HINT = /field|form-?item|form-?group/i;

const matchesFieldContainer = (el) => FIELD_CONTAINER_HINT.test(String(el.className || ''));

/**
 * 字段容器里放值的那块地方。段落标题（「个人基本信息」「教育背景」）也用同样的
 * field 容器 class，但里面只有一行标题、没有值区域——靠这个把它们排除掉。
 */
// 特意不含 component：简道云给每个块（含段落标题）都渲染 .field-component，
// 带上它等于没过滤。真控件靠 combo / value / picker 这些就能命中。
const VALUE_AREA_HINT = /value|combo|select|picker|input|control|upload|checkbox|radio|switch|cascader/i;

const hasValueArea = (container) =>
  [...container.querySelectorAll('*')].some((node) => VALUE_AREA_HINT.test(String(node.className || '')));

/** 容器自己的标签：先找语义 class 的叶子，再退回第一段像标签的文字。 */
function containerFieldLabel(container) {
  const leaves = labelLeaves(container);
  const hinted = leaves.find((leaf) => LABEL_CLASS_HINT.test(String(leaf.el.className || '')));
  return hinted ? hinted.text : (leaves[0]?.text || '');
}

const containerRequired = (container) =>
  [...container.querySelectorAll('[class*="required"]')].some((marker) => tidy(marker.textContent) === '*');

/**
 * 采集没有原生表单元素的字段容器。
 *
 * 简道云、antd、element-ui 这类框架的下拉和多选是纯 div 模拟的：容器里一个
 * input/select 都没有，也没有任何 ARIA role。只查原生控件的话这些字段静默地
 * 不存在——用户会看到「已填写 N 个字段」，然后带着几个空的必填项走到确认投递。
 * 真机在帆软秋招页上确认：意向岗位大类 / 意向团队 / 意向工作地点三个必填项
 * 全是这种控件，一个都没被采到。
 *
 * 这里只做识别和上报，不做填写——填这类控件要模拟点击展开再点选项，是另一件
 * 事。识别出来至少能让提交那一步拦住，并告诉用户哪几个要手动选。
 *
 * index 从原生控件之后接着排，避免和 controls[field.index] 那套下标撞车。
 */
function collectWidgetEntries(root, startIndex) {
  const out = [];
  let index = startIndex;
  for (const container of root.querySelectorAll('*')) {
    if (!matchesFieldContainer(container)) continue;
    if (container.querySelector('input, textarea, select')) continue;
    // 只取最外层：.fx-field 里的 .field-name / .field-component 也含 field
    if (container.parentElement?.closest('*') && [...ancestorsOf(container)].some(matchesFieldContainer)) continue;

    if (!hasValueArea(container)) continue; // 段落标题不是字段

    const label = containerFieldLabel(container);
    if (!label) continue;

    out.push({
      container,
      field: normaliseField({
        label, name: '', id: container.id, type: 'widget', required: containerRequired(container), options: [],
      }, index),
    });
    index += 1;
  }
  return out;
}

/**
 * 按签名找回 widget 的容器元素。
 *
 * widget 没有对应的原生控件，fillApplicationFields 那套 elements[index] 的
 * 定位办法用不上，驱动器需要拿到容器本身才能点开它。
 */
export function widgetContainerFor(root = document, signature) {
  const native = [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()));
  const hit = collectWidgetEntries(root, native.length).find((entry) => entry.field.signature === signature);
  return hit ? hit.container : null;
}

function* ancestorsOf(el) {
  for (let node = el.parentElement; node; node = node.parentElement) yield node;
}

export function collectApplicationFields(root = document) {
  const native = [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()))
    .map((el, index) => normaliseField({
      label: labelFor(el), name: el.getAttribute('name'), id: el.id, placeholder: el.getAttribute('placeholder'),
      type: el.getAttribute('type') || el.tagName.toLowerCase(), required: requiredFor(el),
      options: el.tagName === 'SELECT' ? [...el.options].map((option) => option.textContent?.trim() || '') : [],
    }, index));
  return [...native, ...collectWidgetEntries(root, native.length).map((entry) => entry.field)];
}

export function findSubmitControl(root = document) {
  return [...root.querySelectorAll('button, input[type="submit"], [role="button"]')]
    .find((el) => /^(submit|apply|send|continue|next|提交|投递|申请|继续|下一步)/i.test(String(el.textContent || el.getAttribute('value') || '').trim())) || null;
}

export function formWarnings(fields, root = document) {
  const warnings = [];
  const controls = [...root.querySelectorAll('input, textarea, select')];
  if (fields.some((field) => field.kind === 'resume' && !controls[field.index]?.files?.length)) warnings.push('resume_requires_user_file_selection');
  if (fields.some((field) => field.kind === 'verification')) warnings.push('verification_required');
  if (fields.some((field) => field.kind === 'sensitive_demographic')) warnings.push('sensitive_questions_require_user_choice');
  // 纯 div 模拟的下拉/多选：识别得到但填不了，必须让用户自己选，不能带着空的
  // 必填项走到提交。
  if (fields.some((field) => field.type === 'widget')) warnings.push('custom_widget_requires_user_input');
  return warnings;
}

export function nativeSetValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 按签名填写，而不是按数组下标。
 *
 * 每次填写前重新扫一遍当前 DOM——inspect 时的页面和此刻的页面可能已经不同。
 * 签名找不到或匹配到多个，一律跳过并记录原因：填错框是静默的，用户可能到
 * 面试前才发现，所以宁可不填。
 */
export function fillApplicationFields(root, values = []) {
  const elements = [...root.querySelectorAll('input, textarea, select')];
  const fields = collectApplicationFields(root);
  const filled = [];
  const skipped = [];
  const skip = (signature, reason) => skipped.push({ signature, reason });

  for (const item of values) {
    if (typeof item.value !== 'string') { skip(item.signature, 'invalid_value'); continue; }

    const matches = fields.filter((field) => field.signature === item.signature);
    if (matches.length === 0) { skip(item.signature, 'not_found'); continue; }
    if (matches.length > 1) { skip(item.signature, 'ambiguous'); continue; }

    if (matches[0].type === 'widget') { skip(item.signature, 'unsupported_widget'); continue; }

    const el = elements[matches[0].index];
    if (!el) { skip(item.signature, 'not_found'); continue; }
    if (el.type === 'file') { skip(item.signature, 'file_input'); continue; }

    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((entry) => entry.value === item.value || entry.textContent?.trim() === item.value);
      if (!option) { skip(item.signature, 'option_not_found'); continue; }
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      nativeSetValue(el, item.value);
    }
    filled.push(item.signature);
  }
  return { filled, skipped };
}

/**
 * 填完之后回读，确认值真的留在页面上了。
 *
 * 有些表单（Moka 这类带延迟校验的尤其明显）会在失焦或重渲染时把脚本写入的
 * 值清掉，页面上看起来什么都没发生。不回读的话，我们会告诉用户「已填写 N
 * 个字段」，而实际上一个都没留住。
 *
 * 字段整个消失也算丢失——静默忽略等于假装填成功了。
 */
export function verifyFilledFields(root = document, signatures = []) {
  const fields = collectApplicationFields(root);
  const elements = [...root.querySelectorAll('input, textarea, select')];
  const stuck = [];
  const lost = [];

  for (const signature of signatures) {
    const matches = fields.filter((field) => field.signature === signature);
    const el = matches.length === 1 ? elements[matches[0].index] : null;
    const value = el ? String(el.value ?? '') : '';
    (value.trim() ? stuck : lost).push(signature);
  }
  return { stuck, lost };
}
