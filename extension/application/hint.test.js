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

/**
 * 去掉标题时不要把正文一起弄没。
 *
 * 真机：「本科学校」的页面提示原文是「未搜索到学校名称的同学，请搜索"其他"并选择，
 * 再填写学校名称」，而模型看到的 hint 只有「"其他"」两个字——恢复办法就写在被扔掉
 * 的那部分里。
 *
 * 原因是用 replace(label, '') 去标题：容器文字是多段拼起来的，标题在中间出现时
 * 会把两边切断，只剩一小截。
 */
describe('hint 不能被截坏', () => {
  it('标题出现在容器文字中间时，正文要完整保留', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-name">本科学校</div>
        <div class="field-desc">未搜索到学校名称的同学，请搜索“其他”并选择，再填写学校名称</div>
        <div class="field-component"><div class="x-combo-value">请选择</div></div>
      </div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.hint).toContain('未搜索到学校名称');
    expect(c.hint).toContain('再填写学校名称');
  });

  it('标题在开头时同样完整', () => {
    const root = html(`
      <div class="fx-field"><div class="field-name">学号</div>
        <div class="field-desc">若无学号可填写“无”，不要留空</div>
        <input name="sid"></div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.hint).toContain('若无学号可填写');
    expect(c.hint).toContain('不要留空');
  });
});

/**
 * 裸文本节点也要收进来。
 *
 * 真机：「本科学校」的 hint 只有「"其他"」两个字，而页面原文是「未搜索到学校名称
 * 的同学，请搜索"其他"并选择，再填写学校名称」。结构是这样的——
 *
 *   <div class="field-desc">未搜索到…请搜索<span>"其他"</span>并选择，再填写学校名称</div>
 *
 * 「其他」被标签包着，前后两段是**裸文本节点**。而收集文字时只走元素叶子
 * （querySelectorAll('*')），裸文本节点根本看不见，于是只剩被包着的那两个字。
 * 恢复办法恰恰写在被扔掉的那部分里。
 */
describe('裸文本节点不能丢', () => {
  it('文字被标签切成三段时，三段都要在', () => {
    document.body.innerHTML = `
      <div class="fx-field">
        <div class="field-name">本科学校</div>
        <div class="field-desc">未搜索到学校名称的同学，请搜索<span class="hl">“其他”</span>并选择，再填写学校名称</div>
        <div class="field-component"><input name="s"></div>
      </div>`;
    const [c] = snapshotControls(document.body, { labelSelector: '.field-name' });
    expect(c.hint).toContain('未搜索到学校名称');
    expect(c.hint).toContain('其他');
    expect(c.hint).toContain('再填写学校名称');
  });
});

/**
 * 日期控件的标签藏在更深的地方。
 *
 * 真机实测：普通文本框从 input 到字段容器是 **5 层**，日期控件是 **7 层**——
 * input-inner → x-inner-wrapper → x-input → datetime-label → x-datetime →
 * fx-form-datetime → field-component。而向上找标签的窗口正好是 5 层，日期控件
 * 恰好落在外面。
 *
 * 后果比「填不上」更糟：这三个字段（出生年月、本科毕业时间、研究生毕业时间）在
 * 快照里**有条目但没标签**，模型看不见它们是什么所以填不了，而「问用户」那一步又
 * 会过滤掉没标签的字段——两头都不管，就这么从报告里消失了。
 */
describe('嵌套很深的控件也要找得到标签', () => {
  it('日期控件（7 层）的标签能取到', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-label"><span class="field-required">*</span><div class="field-name">出生年月</div></div>
        <div class="field-component">
          <div class="fx-form-datetime">
            <div class="x-datetime datetime-trigger-input">
              <div class="datetime-label">
                <div class="x-input x-date-input">
                  <div class="x-inner-wrapper"><input class="input-inner" name="birth"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.context).toBe('出生年月');
  });

  it('普通文本框（5 层）不受影响', () => {
    const root = html(`
      <div class="fx-field">
        <div class="field-label"><div class="field-name">姓名</div></div>
        <div class="field-component"><div class="x-input"><div class="x-inner-wrapper"><input name="n"></div></div></div>
      </div>`);
    const [c] = snapshotControls(root, { labelSelector: '.field-name' });
    expect(c.context).toBe('姓名');
  });
});
