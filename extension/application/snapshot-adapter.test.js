import { describe, expect, it } from 'vitest';
import { snapshotControls, elementForHandle, fillByHandle } from './snapshot.js';

/**
 * 站点适配器给出的 label 选择器，能把 context 从「整个字段容器的文字」收窄到
 * 「标题那一个节点」。真机上简道云的容器里混着占位符、单位、校验提示，整坨给
 * 模型既浪费 token 又容易误导。
 */
const html = (markup) => {
  document.body.innerHTML = markup;
  return document.body;
};

describe('snapshot 的 labelSelector', () => {
  const markup = `
    <div class="fx-field">
      <div class="field-name">最高学历</div>
      <div class="field-component">
        <input name="edu" placeholder="请选择" />
        <div class="tip">必填，请如实填写，虚假信息将取消资格</div>
      </div>
    </div>`;

  it('不给选择器时，通用启发式也能越过校验提示拿到标题', () => {
    // 这是修掉的真实缺陷：原来停在第一个「有文字」的祖先 .field-component 上，
    // context 变成那句校验提示，模型看到一堆一模一样的「必填，请如实填写…」，
    // 认不出这是哪个字段。
    const [control] = snapshotControls(html(markup));
    expect(control.context).toBe('最高学历');
  });

  it('给了选择器就只取标题节点', () => {
    const [control] = snapshotControls(html(markup), { labelSelector: '.field-name' });
    expect(control.context).toBe('最高学历');
    expect(control.context).not.toContain('虚假信息');
  });

  it('选择器没命中时退回整坨文字，不会把 context 弄空', () => {
    const [control] = snapshotControls(html(markup), { labelSelector: '.no-such-class' });
    expect(control.context).toContain('最高学历');
  });

  it('非法选择器不炸——适配器将来是服务端下发的不受信数据', () => {
    expect(() => snapshotControls(html(markup), { labelSelector: '((' })).not.toThrow();
    const [control] = snapshotControls(html(markup), { labelSelector: '((' });
    expect(control.context).toContain('最高学历');
  });
});

/**
 * 采集和填写必须用同一份快照选项。
 *
 * 句柄是从 context 派生的，而 labelSelector 会改变 context。inspect 带着适配器
 * 选择器算句柄、fill 不带，两边就是两套句柄，模型作答后一个都定位不到——过门 0。
 */
describe('句柄同源', () => {
  const markup = `
    <div class="fx-field">
      <div class="field-name">最高学历</div>
      <div class="field-component"><input name="" id="" /><div class="tip">必填</div></div>
    </div>`;
  const opts = { labelSelector: '.field-name' };

  it('带同一份选项时，采集出的句柄能定位回元素', () => {
    const root = html(markup);
    const [control] = snapshotControls(root, opts);
    expect(elementForHandle(root, control.handle, opts)).not.toBeNull();
  });

  it('带同一份选项时能填进去', () => {
    const root = html(markup);
    const [control] = snapshotControls(root, opts);
    const result = fillByHandle(root, [{ signature: control.handle, value: '研究生' }], opts);
    expect(result.filled).toEqual([control.handle]);
    expect(root.querySelector('input').value).toBe('研究生');
  });
});
