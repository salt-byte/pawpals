function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function elementLabel(el) {
  if (!el) return '';
  for (const value of [
    el.textContent,
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('placeholder'),
    el.getAttribute?.('title'),
    el.getAttribute?.('value'),
    el.getAttribute?.('alt'),
  ]) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

export function fingerprint(el) {
  const rect = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), text: elementLabel(el), x: Math.round(rect.x), y: Math.round(rect.y) };
}

export function fingerprintMatches(a, b, tolerancePx = 8) {
  return Boolean(a && b && a.tag === b.tag && a.text === b.text
    && Math.abs(a.x - b.x) <= tolerancePx && Math.abs(a.y - b.y) <= tolerancePx);
}
