import { describe, expect, it } from 'vitest';
import { snapshotControls } from './snapshot.js';
import { verifyByHandle } from './readback.js';

/**
 * 回读：填完之后，用**同一个句柄**把页面上的当前值读回来对一遍。
 *
 * 为什么必须同源：以前采集走快照句柄、校验走 form.js 的另一套签名，于是「填进去
 * 了却被判失败」——两边根本不在说同一个框。真机上表现为 filled 有数字、页面上却
 * 看不出变化，或者反过来。
 *
 * 回读是唯一算数的成功判据。模型说填了不算，fill 返回 ok 也不算，页面上读回来
 * 等于目标值才算。
 */
const html = (m) => { document.body.innerHTML = m; return document.body; };

describe('快照带当前值', () => {
  it('原生输入框报它的 value', () => {
    const root = html('<div class="fx-field"><div class="field-name">姓名</div><input name="n" value="张小明"></div>');
    expect(snapshotControls(root)[0].value).toBe('张小明');
  });

  it('空框报空串，不报 undefined', () => {
    const root = html('<div class="fx-field"><div class="field-name">姓名</div><input name="n"></div>');
    expect(snapshotControls(root)[0].value).toBe('');
  });

  it('widget 报它显示出来的值', () => {
    const root = html('<div class="fx-field"><div class="field-name">学历</div><div class="field-component"><div class="x-combo-value">研究生</div></div></div>');
    const w = snapshotControls(root).find((c) => c.type === 'widget');
    expect(w.value).toBe('研究生');
  });

  it('widget 还没选时，占位符不算值', () => {
    const root = html('<div class="fx-field"><div class="field-name">学历</div><div class="field-component"><div class="x-combo-value placeholder">请选择</div></div></div>');
    const w = snapshotControls(root).find((c) => c.type === 'widget');
    expect(w.value).toBe('');
  });
});

describe('verifyByHandle', () => {
  const root = () => html(`
    <div class="fx-field"><div class="field-name">姓名</div><input name="n" value="张小明"></div>
    <div class="fx-field"><div class="field-name">手机</div><input name="p" value=""></div>`);

  const handles = (r) => Object.fromEntries(snapshotControls(r).map((c) => [c.context, c.handle]));

  it('值对上了算确认', () => {
    const r = root();
    const h = handles(r);
    const out = verifyByHandle(r, [{ signature: h['姓名'], value: '张小明' }]);
    expect(out.confirmed).toEqual([h['姓名']]);
    expect(out.mismatched).toEqual([]);
  });

  it('页面上是空的就算没填上——不听 fill 的自述', () => {
    const r = root();
    const h = handles(r);
    const out = verifyByHandle(r, [{ signature: h['手机'], value: '13800138000' }]);
    expect(out.confirmed).toEqual([]);
    expect(out.mismatched[0]).toMatchObject({ signature: h['手机'], expected: '13800138000', actual: '' });
  });

  it('包含即可，不要求完全相等——多选控件会显示成「A，B」', () => {
    const r = html('<div class="fx-field"><div class="field-name">语言</div><div class="field-component"><div class="x-combo-value">英语雅思7+，日语N2</div></div></div>');
    const w = snapshotControls(r).find((c) => c.type === 'widget');
    expect(verifyByHandle(r, [{ signature: w.handle, value: '英语雅思7+' }]).confirmed).toEqual([w.handle]);
  });

  it('句柄找不到时单独归类，不混进「没填上」', () => {
    const out = verifyByHandle(root(), [{ signature: 'no-such-handle', value: 'x' }]);
    expect(out.missing).toEqual(['no-such-handle']);
    expect(out.mismatched).toEqual([]);
  });

  it('空输入返回三个空数组，不炸', () => {
    expect(verifyByHandle(root(), [])).toEqual({ confirmed: [], mismatched: [], missing: [] });
  });
});

import { dismissPanels } from './readback.js';

/**
 * 采快照前先收起浮层。
 *
 * 快照已经会跳过浮层里的东西，但那依赖认得出「什么是浮层」——真机上仍然漏掉过
 * 一类（一轮报 48 个字段，实际 39）。与其继续往选择器里加 class，不如在采之前
 * 主动把浮层关掉：关掉了就没有认不认得出的问题。
 *
 * 关不掉也不影响正确性，跳过浮层那道防线还在——这是两道，不是替换。
 */
describe('dismissPanels', () => {
  it('按 Esc 并点一下空白处', () => {
    const keys = [];
    const clicks = [];
    document.body.addEventListener('keydown', (e) => keys.push(e.key));
    document.body.addEventListener('mousedown', () => clicks.push(1));
    dismissPanels(document);
    expect(keys).toContain('Escape');
    expect(clicks.length).toBeGreaterThan(0);
  });

  it('页面没有 body 时不炸', () => {
    expect(() => dismissPanels({})).not.toThrow();
  });
});

/**
 * 选项标签不是「当前值」。
 *
 * 用户截图发现的：页面上「是否有获奖经历 ○是 ○否」两个都没选中，而我们报告说
 * 「已确认填写 = 是」。因为读当前值时把选项标签「是」当成了已选中的值。
 *
 * 后果有两层：一是数字虚高，二是**系统认为它已经填好了，从此再也不会去填它**
 * ——那一轮的 trace 里这三个字段根本没出现过。三个必填项就这么永久漏掉了。
 */
describe('单选控件没选中时不能报出值', () => {
  it('两个选项都没选中 → 值为空', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-name">是否有获奖经历</div>
        <div class="field-component">
          <div class="x-radio-item"><span class="radio-dot"></span><span class="radio-label">是</span></div>
          <div class="x-radio-item"><span class="radio-dot"></span><span class="radio-label">否</span></div>
        </div>
      </div>`);
    const w = snapshotControls(root, { labelSelector: '.field-name' }).find((c) => c.type === 'widget');
    expect(w.value).toBe('');
  });

  it('选中了才报那个值', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-name">是否有获奖经历</div>
        <div class="field-component">
          <div class="x-radio-item is-checked"><span class="radio-label">是</span></div>
          <div class="x-radio-item"><span class="radio-label">否</span></div>
        </div>
      </div>`);
    const w = snapshotControls(root, { labelSelector: '.field-name' }).find((c) => c.type === 'widget');
    expect(w.value).toBe('是');
  });

  it('普通下拉不受影响——它只有一段显示文字', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-name">学历</div>
        <div class="field-component"><div class="x-combo-value">研究生</div></div>
      </div>`);
    const w = snapshotControls(root, { labelSelector: '.field-name' }).find((c) => c.type === 'widget');
    expect(w.value).toBe('研究生');
  });
});
