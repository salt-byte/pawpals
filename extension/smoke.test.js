import { describe, it, expect } from 'vitest';

describe('测试基建', () => {
  it('jsdom 环境可用', () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    expect(document.getElementById('b').textContent).toBe('点我');
  });
});
