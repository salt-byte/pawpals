/** Return whether an element is rendered and has a clickable area. */
export function isVisible(el, win = globalThis.window) {
  if (!el || el.nodeType !== 1) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = win.getComputedStyle(el);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    // jsdom returns an empty string for an inherited, unspecified opacity;
    // browsers return "1". Only an explicit computed zero is transparent.
    && style.opacity !== '0';
}

/** Return whether any portion of an element intersects the current viewport. */
export function isInViewport(el, win = globalThis.window) {
  if (!el || el.nodeType !== 1) return false;
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
}
