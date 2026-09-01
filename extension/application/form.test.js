import { beforeEach, describe, expect, it } from 'vitest';
import { collectApplicationFields, fillApplicationFields, findSubmitControl, formWarnings } from './form.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('generic official application form', () => {
  it('extracts fields, warnings, and the final submission control', () => {
    document.body.innerHTML = '<label for="email">Email</label><input id="email" required><input type="file" aria-label="Resume"><button>Submit application</button>';
    const fields = collectApplicationFields();
    expect(fields.map((field) => field.kind)).toEqual(['email', 'resume']);
    expect(formWarnings(fields)).toContain('resume_requires_user_file_selection');
    expect(findSubmitControl()?.textContent).toContain('Submit');
  });

  it('每个字段都带上可跨渲染复用的签名', () => {
    document.body.innerHTML = '<input name="email" type="email"><input name="phone" type="tel">';
    const [email, phone] = collectApplicationFields();
    expect(email.signature).toBeTruthy();
    expect(email.signature).not.toBe(phone.signature);
  });

  it('按签名填写，只填明确给出的非文件字段', () => {
    document.body.innerHTML = '<input name="email"><input type="file" name="cv">';
    const fields = collectApplicationFields();
    const result = fillApplicationFields(document, [
      { signature: fields[0].signature, value: 'a@example.com' },
      { signature: fields[1].signature, value: 'resume.pdf' },
    ]);
    expect(result.filled).toEqual([fields[0].signature]);
    expect(document.querySelector('input').value).toBe('a@example.com');
  });

  it('页面重渲染导致索引位移后，仍然填进正确的框', () => {
    document.body.innerHTML = '<input name="email"><input name="phone">';
    const before = collectApplicationFields();
    const emailSig = before[0].signature;

    // 用户点了「添加一段实习经历」，表单最前面多出两个字段，原索引全部位移
    document.body.innerHTML = '<input name="company"><input name="role"><input name="email"><input name="phone">';

    const result = fillApplicationFields(document, [{ signature: emailSig, value: 'a@example.com' }]);
    expect(result.filled).toEqual([emailSig]);
    expect(document.querySelector('input[name="email"]').value).toBe('a@example.com');
    expect(document.querySelector('input[name="company"]').value).toBe('');
  });

  it('签名在当前页面找不到时跳过并报告，绝不改填别的框', () => {
    document.body.innerHTML = '<input name="email">';
    const result = fillApplicationFields(document, [{ signature: 'name=gone|id=|type=text|label=', value: 'x' }]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('not_found');
    expect(document.querySelector('input').value).toBe('');
  });

  it('签名匹配到多个同样的框时跳过，歧义不猜', () => {
    document.body.innerHTML = '<input name="dup"><input name="dup">';
    const fields = collectApplicationFields();
    const result = fillApplicationFields(document, [{ signature: fields[0].signature, value: 'x' }]);
    expect(result.filled).toEqual([]);
    expect(result.skipped[0].reason).toBe('ambiguous');
    expect(document.querySelectorAll('input')[0].value).toBe('');
  });
});

describe('verifyFilledFields', () => {
  it('值确实写进去了就算通过', async () => {
    const { verifyFilledFields } = await import('./form.js');
    document.body.innerHTML = '<input name="email" value="a@example.com">';
    const [field] = collectApplicationFields();
    expect(verifyFilledFields(document, [field.signature])).toEqual({ stuck: [field.signature], lost: [] });
  });

  it('值被页面自己的校验清掉时报告丢失', async () => {
    const { verifyFilledFields } = await import('./form.js');
    document.body.innerHTML = '<input name="email">';
    const [field] = collectApplicationFields();
    expect(verifyFilledFields(document, [field.signature])).toEqual({ stuck: [], lost: [field.signature] });
  });

  it('字段整个消失时也算丢失，不静默忽略', async () => {
    const { verifyFilledFields } = await import('./form.js');
    document.body.innerHTML = '<input name="other">';
    expect(verifyFilledFields(document, ['name=gone|id=|type=text|label='])).toEqual({
      stuck: [], lost: ['name=gone|id=|type=text|label='],
    });
  });
});

/**
 * 国内表单构建器（简道云、金数据这类）的通行写法：label 不是 <label>，而是
 * 同容器里的兄弟节点；必填靠一个 * 标记，不用原生 required。
 * 真机在帆软秋招网申页（简道云）上实测：24 个字段全部 label 为空、全部落进
 * custom，连简历附件都没被认出来——「简历先传」那道闸整个失效。
 */
describe('容器式标签（简道云类表单）', () => {
  const field = (labelText, inner, required = true) =>
    `<div class="fx-field">${required ? '<span class="field-required">*</span>' : ''}` +
    `<div class="field-name">${labelText}</div><div class="x-input">${inner}</div></div>`;

  it('label 在兄弟节点里也能取到', () => {
    document.body.innerHTML = field('姓名', '<input type="text">');
    expect(collectApplicationFields()[0].label).toBe('姓名');
  });

  it('取到 label 之后简历附件才认得出来——这是「简历先传」那道闸的前提', () => {
    document.body.innerHTML = field('简历附件', '<input type="file">');
    const fields = collectApplicationFields();
    expect(fields[0].kind).toBe('resume');
    expect(formWarnings(fields)).toContain('resume_requires_user_file_selection');
  });

  it('* 标记等同于必填，不依赖原生 required 属性', () => {
    document.body.innerHTML = field('手机号', '<input type="text">');
    expect(collectApplicationFields()[0].required).toBe(true);
  });

  it('没有 * 标记就不是必填', () => {
    document.body.innerHTML = field('内推码', '<input type="text">', false);
    expect(collectApplicationFields()[0].required).toBe(false);
  });

  it('* 本身不能当标签', () => {
    document.body.innerHTML = '<div class="fx-field"><span class="field-required">*</span><input type="text"></div>';
    expect(collectApplicationFields()[0].label).toBe('');
  });

  it('大段说明文字不能当标签——只取第一行且有长度上限', () => {
    const long = '意向团队'.padEnd(200, '说明');
    document.body.innerHTML = `<div class="fx-field"><div class="field-name">${long}</div><input type="text"></div>`;
    expect(collectApplicationFields()[0].label.length).toBeLessThanOrEqual(40);
  });

  it('标准 label[for] 仍然优先，不被容器兜底覆盖', () => {
    document.body.innerHTML =
      '<div class="fx-field"><div class="field-name">容器里的字</div>' +
      '<label for="e1">Email</label><input id="e1" type="text"></div>';
    expect(collectApplicationFields()[0].label).toBe('Email');
  });

  it('aria-label 和 placeholder 仍然优先于容器兜底', () => {
    document.body.innerHTML = '<div class="fx-field"><div class="field-name">容器里的字</div><input aria-label="Phone"></div>';
    expect(collectApplicationFields()[0].label).toBe('Phone');
  });
});

describe('容器式标签：真机暴露的三个缺陷', () => {
  it('优先取带 label/name 语义 class 的节点，而不是容器里第一段文字', () => {
    document.body.innerHTML =
      '<div class="fx-field"><span class="field-required">*</span>' +
      '<div class="field-name">简历附件</div>' +
      '<div class="x-upload"><span class="x-upload-text">选择</span><input type="file"></div></div>';
    const fields = collectApplicationFields();
    expect(fields[0].label).toBe('简历附件');
    expect(fields[0].kind).toBe('resume');
    expect(formWarnings(fields)).toContain('resume_requires_user_file_selection');
  });

  it('没有 class 提示时取控件之前最近的那段文字，不是容器里第一段', () => {
    document.body.innerHTML = '<div><div>上一个字段的值</div><div>邮箱</div><input type="text"></div>';
    expect(collectApplicationFields()[0].label).toBe('邮箱');
  });

  it('不把页面标题当标签——往上找过头会取到整页的大标题', () => {
    document.title = '帆软2027届秋季校招招聘';
    document.body.innerHTML =
      '<div><h1>帆软2027届秋季校招招聘</h1><div class="wrap"><input type="text"></div></div>';
    expect(collectApplicationFields()[0].label).toBe('');
  });
});

describe('fieldKind：真机暴露的中文标签', () => {
  it('「手机」和「手机号」都要认出来——真实表单上写的是「手机」', () => {
    document.body.innerHTML = '<div><div class="field-name">手机</div><input type="text"></div>';
    expect(collectApplicationFields()[0].kind).toBe('phone');
  });
});

