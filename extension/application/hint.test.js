import { describe, expect, it } from 'vitest';
import { snapshotControls } from './snapshot.js';

/**
 * 页面自己写的说明，要传给模型。
 *
 * 帆软那张表在「意向工作地点」旁边写着「请先选择【意向岗位】，再查看可选工作
 * 地点~」，在「学号」的占位符里写着「若无学号可填写"无"」。这些是页面给人看的
 * 说明书，模型看得懂，但它一直没看到——
 *
 * context 早先抓的是整个容器的文字（包含这些说明），但也混着校验提示，模型分不清
 * 字段是哪个。为了精确，改成只取标题节点，结果精确了，也把说明书一起扔了。
 *
 * 所以分开：context 保持精确（句柄从它派生，必须稳定），hint 单独装说明。hint
 * **不能**进句柄——页面文案一改，句柄就变，模型作答后一个都定位不到。
 */
const html = (m) => { document.body.innerHTML = m; return document.body; };

describe('hint', () => {
  it('捡起标题之外的说明文字', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-name">意向工作地点</div>
        <div class="field-desc">请先选择【意向岗位】，再查看可选工作地点~</div>
        <div class="field-component"><div class="x-combo-value">可多选</div></div>
      </div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.context).toBe('意向工作地点');
    expect(c.hint).toContain('请先选择【意向岗位】');
  });

  it('占位符也算说明——「若无学号可填写无」是给人看的指示', () => {
    const root = html(`
      <div class="fx-field"><div class="field-name">学号</div>
        <input name="sid" placeholder='若无学号可填写"无"'></div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.hint).toContain('若无学号');
  });

  it('说明里不重复标题本身', () => {
    const root = html(`
      <div class="fx-field"><div class="field-name">性别</div>
        <div class="field-component"><input name="g"></div></div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.hint).toBe('');
  });

  it('hint 不进句柄——页面文案改了，句柄不能跟着变', () => {
    const withHint = html(`
      <div class="fx-field"><div class="field-name">学历</div>
        <div class="field-desc">请如实填写，虚假信息将取消资格</div>
        <input name="edu"></div>`);
    const a = snapshotControls(withHint, { labelSelector: '.field-name' })[0].handle;
    const changed = html(`
      <div class="fx-field"><div class="field-name">学历</div>
        <div class="field-desc">换了一句完全不同的提示文案</div>
        <input name="edu"></div>`);
    const b = snapshotControls(changed, { labelSelector: '.field-name' })[0].handle;
    expect(a).toBe(b);
  });

  it('说明有长度上限，不把整页规则塞进 prompt', () => {
    const long = '注意事项：' + '很长的说明'.repeat(200);
    const root = html(`<div class="fx-field"><div class="field-name">备注</div>
      <div class="field-desc">${long}</div><input name="r"></div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.hint.length).toBeLessThanOrEqual(200);
  });
});
