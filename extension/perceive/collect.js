import { elementLabel, fingerprint } from './fingerprint.js';
import { isVisible } from './visibility.js';

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]',
  '[role="tab"]', '[role="checkbox"]', '[onclick]', '[tabindex]',
].join(',');

function elementType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return ['submit', 'button'].includes((el.getAttribute('type') || 'text').toLowerCase()) ? 'button' : 'input';
  if (tag === 'textarea') return 'input';
  if (tag === 'select') return 'select';
  if (tag === 'a' || el.getAttribute('role') === 'link') return 'link';
  return 'button';
}

export function collectInteractive(root = document, opts = {}) {
  const maxElements = opts.maxElements ?? 120;
  const win = opts.win ?? globalThis.window;
  const items = [];
  for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (items.length >= maxElements) break;
    if (el.getAttribute('tabindex') === '-1' || el.hasAttribute('disabled') || !isVisible(el, win)) continue;
    items.push({ index: items.length, tag: el.tagName.toLowerCase(), type: elementType(el), label: elementLabel(el), fingerprint: fingerprint(el), el });
  }
  return items;
}

export function renderForPrompt(elements) {
  if (!elements?.length) return '（页面上没有可交互元素）';
  return elements.map((item) => `[${item.index}] ${item.type} "${item.label}"`).join('\n');
}
