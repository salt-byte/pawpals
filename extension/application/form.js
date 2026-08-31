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

export function fillApplicationFields(root, values = []) {
  const elements = [...root.querySelectorAll('input, textarea, select')];
  const filled = [];
  for (const item of values) {
    const el = elements[item.index];
    if (!el || el.type === 'file' || typeof item.value !== 'string') continue;
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find((entry) => entry.value === item.value || entry.textContent?.trim() === item.value);
      if (!option) continue;
      el.value = option.value; el.dispatchEvent(new Event('change', { bubbles: true }));
    } else nativeSetValue(el, item.value);
    filled.push(item.index);
  }
  return filled;
}
