import { beforeEach, describe, expect, it } from 'vitest';
import { isInViewport, isVisible } from './visibility.js';

function stubRect(el, { x = 0, y = 0, width = 0, height = 0 }) {
  el.getBoundingClientRect = () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height });
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('visibility', () => {
  it('excludes non-elements, empty boxes, and hidden elements', () => {
    expect(isVisible(null)).toBe(false);
    expect(isVisible(document.createTextNode('x'))).toBe(false);
    const empty = stubRect(document.body.appendChild(document.createElement('button')), {});
    expect(isVisible(empty)).toBe(false);
    const hidden = stubRect(document.body.appendChild(document.createElement('button')), { width: 100, height: 30 });
    hidden.style.display = 'none';
    expect(isVisible(hidden)).toBe(false);
    const transparent = stubRect(document.body.appendChild(document.createElement('button')), { width: 100, height: 30 });
    transparent.style.opacity = '0';
    expect(isVisible(transparent)).toBe(false);
  });

  it('accepts a rendered element and detects viewport intersection', () => {
    const el = stubRect(document.body.appendChild(document.createElement('button')), { x: 10, y: 10, width: 100, height: 30 });
    expect(isVisible(el)).toBe(true);
    expect(isInViewport(el)).toBe(true);
    stubRect(el, { x: 10, y: -200, width: 100, height: 30 });
    expect(isInViewport(el)).toBe(false);
  });
});
