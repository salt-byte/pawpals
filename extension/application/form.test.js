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
