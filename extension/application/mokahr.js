import { nativeSetValue } from './form.js';

const TYPE_BY_CLASS = [
  ['cascader', /cascader/i],
  ['day_info', /day[-_]?info|date/i],
  ['select_info', /select[-_]?info|select/i],
  ['string_info', /string[-_]?info|input/i],
];

/** One-pass Moka form scan. Class tokens are treated as hints, never exact hashes. */
export function scanMokaFields(root = document) {
  return [...root.querySelectorAll('input, textarea, [contenteditable="true"]')].map((el, index) => {
    const container = el.closest('[class]');
    const classes = String(container?.className || el.className || '');
    const kind = TYPE_BY_CLASS.find(([, pattern]) => pattern.test(classes))?.[0] || 'string_info';
    return { index, kind, value: el.value ?? el.textContent ?? '', label: el.getAttribute('aria-label') || el.placeholder || '' };
  });
}

/** Fill every plain-text field, then blur once so delayed Moka validation refreshes. */
export function fillMokaTextFields(root, values) {
  const controls = [...root.querySelectorAll('input, textarea')];
  const filled = [];
  for (const item of values) {
    const el = controls[item.index];
    if (!el || item.kind && item.kind !== 'string_info') continue;
    nativeSetValue(el, String(item.value));
    filled.push(item.index);
  }
  (root.activeElement || controls[0])?.blur?.();
  return filled;
}

/** Re-read values after blur; an old red error alone is never treated as a failed fill. */
export function verifyMokaFields(root = document) {
  return scanMokaFields(root).map((field) => ({ ...field, validValuePresent: String(field.value).trim().length > 0 }));
}
