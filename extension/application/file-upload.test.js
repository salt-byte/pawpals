import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFileUploads, decodeUpload } from './file-upload.js';

beforeEach(() => { document.body.innerHTML = ''; });

/**
 * jsdom 没有 DataTransfer，也不接受非 FileList 赋给 input.files，所以「造
 * FileList」和「赋值」两步用注入的假实现。这两行的真实行为已在 Chrome 上实测：
 * input.files = dt.files 可行，change 事件正常触发。
 */
function seams() {
  const assigned = [];
  return {
    makeFileList: (files) => ({ length: files.length, files, item: (i) => files[i] }),
    assignFiles: (el, list) => { assigned.push({ el, list }); el._files = list; },
    assigned,
  };
}

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('decodeUpload', () => {
  it('把 base64 还原成 File，保留文件名和类型', () => {
    const file = decodeUpload({ name: '简历.pdf', type: 'application/pdf', dataBase64: b64('%PDF-1.4') });
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('简历.pdf');
    expect(file.type).toBe('application/pdf');
  });

  it('缺字段或 base64 非法时返回 null，不抛错', () => {
    expect(decodeUpload({ name: 'a.pdf' })).toBe(null);
    expect(decodeUpload({ dataBase64: b64('x') })).toBe(null);
    expect(decodeUpload(null)).toBe(null);
  });
});

describe('applyFileUploads', () => {
  const form = () =>
    '<div class="fx-field"><div class="field-name">简历附件</div><input type="file" name="resume"></div>' +
    '<input type="text" name="email">';

  it('按签名定位文件框，装上文件并派发 change', () => {
    document.body.innerHTML = form();
    const input = document.querySelector('input[type=file]');
    const changes = [];
    input.addEventListener('change', () => changes.push('change'));
    const s = seams();

    const result = applyFileUploads(document, [
      { signature: 'name=resume|id=|type=file|label=简历附件', name: '简历.pdf', type: 'application/pdf', dataBase64: b64('%PDF') },
    ], s);

    expect(result.uploaded).toEqual(['name=resume|id=|type=file|label=简历附件']);
    expect(result.skipped).toEqual([]);
    expect(s.assigned).toHaveLength(1);
    expect(s.assigned[0].list.length).toBe(1);
    expect(changes).toEqual(['change']);
  });

  it('签名定位不到就跳过并说明原因，不猜别的框', () => {
    document.body.innerHTML = form();
    const result = applyFileUploads(document, [
      { signature: 'name=不存在|id=|type=file|label=', name: 'a.pdf', type: 'application/pdf', dataBase64: b64('x') },
    ], seams());
    expect(result.uploaded).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'not_found' });
  });

  it('签名有歧义时跳过——两个一样的框，猜错就传错地方', () => {
    document.body.innerHTML = '<input type="file"><input type="file">';
    const fields = applyFileUploads(document, [
      { signature: 'name=|id=|type=file|label=', name: 'a.pdf', type: 'application/pdf', dataBase64: b64('x') },
    ], seams());
    expect(fields.skipped[0]).toMatchObject({ reason: 'ambiguous' });
  });

  it('目标不是文件框时跳过——不能把 base64 当文本填进去', async () => {
    document.body.innerHTML = form();
    const { collectApplicationFields } = await import('./form.js');
    const emailField = collectApplicationFields(document).find((f) => f.type === 'text');
    const result = applyFileUploads(document, [
      { signature: emailField.signature, name: 'a.pdf', type: 'application/pdf', dataBase64: b64('x') },
    ], seams());
    expect(result.skipped[0]).toMatchObject({ reason: 'not_file_input' });
  });

  it('数据解不开时跳过', () => {
    document.body.innerHTML = form();
    const result = applyFileUploads(document, [
      { signature: 'name=resume|id=|type=file|label=简历附件', name: '简历.pdf' },
    ], seams());
    expect(result.skipped[0]).toMatchObject({ reason: 'decode_failed' });
  });

  it('赋值抛错时算失败而不是崩掉整个任务', () => {
    document.body.innerHTML = form();
    const s = seams();
    s.assignFiles = () => { throw new Error('read-only'); };
    const result = applyFileUploads(document, [
      { signature: 'name=resume|id=|type=file|label=简历附件', name: '简历.pdf', type: 'application/pdf', dataBase64: b64('x') },
    ], s);
    expect(result.uploaded).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: 'assign_failed' });
  });

  it('没有待上传项时什么都不做', () => {
    document.body.innerHTML = form();
    expect(applyFileUploads(document, [], seams())).toEqual({ uploaded: [], skipped: [] });
    expect(applyFileUploads(document, undefined, seams())).toEqual({ uploaded: [], skipped: [] });
  });
});
