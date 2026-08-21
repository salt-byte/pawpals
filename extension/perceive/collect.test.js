import { beforeEach, describe, expect, it } from 'vitest';
import { collectInteractive, renderForPrompt } from './collect.js';
import { elementLabel, fingerprint, fingerprintMatches } from './fingerprint.js';

function layoutAll() {
  let y = 10;
  for (const el of document.querySelectorAll('*')) {
    const zero = el.hasAttribute('data-zero');
    const rect = { x: 10, y, width: zero ? 0 : 120, height: zero ? 0 : 32 };
    el.getBoundingClientRect = () => ({ ...rect, top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height });
    y += 40;
  }
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('fingerprints', () => {
  it('uses human-readable labels and positions to detect stale targets', () => {
    document.body.innerHTML = '<button>  立即   沟通 </button><input placeholder="搜索职位">';
    layoutAll();
    const button = document.querySelector('button');
    expect(elementLabel(button)).toBe('立即 沟通');
    expect(elementLabel(document.querySelector('input'))).toBe('搜索职位');
    const printed = fingerprint(button);
    expect(fingerprintMatches(printed, { ...printed, x: printed.x + 8 })).toBe(true);
    expect(fingerprintMatches(printed, { ...printed, text: '已沟通' })).toBe(false);
  });
});

describe('interactive collection', () => {
  it('collects visible controls in contiguous order', () => {
    document.body.innerHTML = '<button>立即沟通</button><a href="/job/1">岗位详情</a><input placeholder="搜索职位"><button data-zero>隐藏</button>';
    layoutAll();
    const items = collectInteractive(document);
    expect(items.map((item) => item.label)).toEqual(['立即沟通', '岗位详情', '搜索职位']);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(items[2].type).toBe('input');
    expect(renderForPrompt(items)).toContain('[0] button "立即沟通"');
  });

  it('excludes unavailable controls and honours the limit', () => {
    document.body.innerHTML = '<button disabled>禁用</button><div tabindex="-1">跳过</div>' + Array.from({ length: 10 }, (_, i) => `<button>按钮${i}</button>`).join('');
    layoutAll();
    expect(collectInteractive(document, { maxElements: 4 })).toHaveLength(4);
    expect(renderForPrompt([])).toBe('（页面上没有可交互元素）');
  });
});
