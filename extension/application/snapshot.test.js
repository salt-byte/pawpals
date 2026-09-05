import { beforeEach, describe, expect, it } from 'vitest';
import { snapshotControls } from './snapshot.js';

beforeEach(() => { document.body.innerHTML = ''; });

/**
 * 不再用代码去「理解」页面。
 *
 * 今天修的 25 个缺陷里，有 8 个是启发式在猜页面：标签在哪个兄弟节点、哪个 div
 * 是字段容器、哪段文字是选项、script 内容算不算标签。每换一家表单构建器就要再
 * 猜一轮，而且猜错时是静默的——「简历附件」认不出来导致整道安全闸空转。
 *
 * 改成：只做机械可靠的事（找到控件、给稳定句柄、抓周围原文），把「这是什么框」
 * 交给模型判断。它看得懂「* / 姓名 / [输入框]」这种排布，不需要我们先猜对。
 */
describe('snapshotControls', () => {
  it('每个控件给一个稳定句柄和它周围的原文', () => {
    document.body.innerHTML =
      '<div class="fx-field"><span>*</span><div class="field-name">姓名</div><input type="text" name="n"></div>';
    const [control] = snapshotControls(document);

    expect(control.handle).toBeTruthy();
    expect(control.context).toContain('姓名');
    expect(control.type).toBe('text');
  });

  it('不猜标签——只给原文，让模型自己判断', () => {
    document.body.innerHTML = '<div><div>手机</div><input type="text"></div>';
    const [control] = snapshotControls(document);
    expect(control).not.toHaveProperty('label');
    expect(control).not.toHaveProperty('kind');
    expect(control.context).toContain('手机');
  });

  it('script 和 style 的内容绝不进快照——那会把页面令牌送进模型', () => {
    document.body.innerHTML =
      '<div><script>window.token="SECRET123";<\/script><div>邮箱</div><input type="text"></div>';
    const [control] = snapshotControls(document);
    expect(control.context).not.toContain('SECRET');
    expect(control.context).toContain('邮箱');
  });

  it('原文有长度上限——整页说明文字塞进去只会淹没信息', () => {
    document.body.innerHTML = `<div><div>${'说明'.repeat(500)}</div><input type="text"></div>`;
    expect(snapshotControls(document)[0].context.length).toBeLessThanOrEqual(200);
  });

  it('没有原生控件的 div 模拟控件也要出现在快照里', () => {
    document.body.innerHTML =
      '<div class="fx-field"><div class="field-name">学历</div>' +
      '<div class="field-component"><div class="x-combo"><div class="value-wrapper"></div></div></div></div>';
    const [control] = snapshotControls(document);
    expect(control.type).toBe('widget');
    expect(control.context).toContain('学历');
  });

  it('文件框单独标出来——这一类永远由代码把关，不交给模型', () => {
    document.body.innerHTML = '<div><div>简历附件</div><input type="file"></div>';
    const [control] = snapshotControls(document);
    expect(control.type).toBe('file');
  });

  it('同一个控件两次快照的句柄一致，页面重排也不变', () => {
    document.body.innerHTML = '<div><div>邮箱</div><input type="text" name="email"></div>';
    const first = snapshotControls(document)[0].handle;
    document.body.insertAdjacentHTML('afterbegin', '<div>插在前面的东西</div>');
    const again = snapshotControls(document).find((c) => c.context.includes('邮箱'));
    expect(again.handle).toBe(first);
  });

  it('不同控件句柄不同', () => {
    document.body.innerHTML = '<input type="text" name="a"><input type="text" name="b">';
    const [x, y] = snapshotControls(document);
    expect(x.handle).not.toBe(y.handle);
  });

  it('隐藏和提交按钮不进快照', () => {
    document.body.innerHTML = '<input type="hidden" name="h"><input type="submit"><input type="text" name="ok">';
    const controls = snapshotControls(document);
    expect(controls).toHaveLength(1);
    expect(controls[0].type).toBe('text');
  });

  it('快照条数有上限——超大页面不能把整棵树塞给模型', () => {
    document.body.innerHTML = Array.from({ length: 400 }, (_, i) => `<input type="text" name="f${i}">`).join('');
    expect(snapshotControls(document, { maxControls: 120 })).toHaveLength(120);
  });
});
