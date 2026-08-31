import { normaliseField } from './schema.js';

function labelFor(el) {
  const explicit = el.id
    ? [...document.querySelectorAll('label')].find((label) => label.htmlFor === el.id)?.textContent
    : '';
  return String(explicit || el.closest('label')?.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
}

export function collectApplicationFields(root = document) {
  return [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()))
    .map((el, index) => normaliseField({
      label: labelFor(el), name: el.getAttribute('name'), id: el.id, placeholder: el.getAttribute('placeholder'),
      type: el.getAttribute('type') || el.tagName.toLowerCase(), required: el.required || el.getAttribute('aria-required') === 'true',
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
