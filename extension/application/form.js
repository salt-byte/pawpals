import { normaliseField } from './schema.js';

const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION']);
/** 标签最长取这么多字——再长就不是标签，是说明文字。 */
const LABEL_MAX = 40;
/** 往上找容器的层数上限。再高就会取到整个表单区块的标题。 */
const CONTAINER_DEPTH = 5;

const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** 只有标点或必填星号的文字不算标签。 */
const isLabelish = (text) => Boolean(text) && !/^[\s*·:：)(（）\-—|]+$/.test(text);

/** class 里带这些词的节点，多半就是字段名。 */
const LABEL_CLASS_HINT = /label|field-?name|field-?title|form-?item-?label/i;

/** 收集容器里所有"像标签"的叶子节点。 */
function labelLeaves(node) {
  const leaves = [];
  for (const candidate of node.querySelectorAll('*')) {
    if (CONTROL_TAGS.has(candidate.tagName)) continue;
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
    );
    if (hinted) return hinted.text;
  }

  // 第二遍：就近取控件前面那一段文字
  for (const node of ancestors) {
    const preceding = labelLeaves(node).filter(
      (leaf) => usable(leaf.text) && (el.compareDocumentPosition(leaf.el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
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

export function collectApplicationFields(root = document) {
  return [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()))
    .map((el, index) => normaliseField({
      label: labelFor(el), name: el.getAttribute('name'), id: el.id, placeholder: el.getAttribute('placeholder'),
      type: el.getAttribute('type') || el.tagName.toLowerCase(), required: requiredFor(el),
      options: el.tagName === 'SELECT' ? [...el.options].map((option) => option.textContent?.trim() || '') : [],
    }, index));
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
