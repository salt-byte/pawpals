/**
 * 把简历等附件装进页面的文件输入框。
 *
 * 一度以为这做不到——浏览器确实不允许脚本设置 input.value 的文件路径。但
 * input.files 是可以赋值的，只要给的是从 DataTransfer 拿到的 FileList：
 *
 *   const dt = new DataTransfer();
 *   dt.items.add(new File([blob], '简历.pdf', { type: 'application/pdf' }));
 *   input.files = dt.files;
 *   input.dispatchEvent(new Event('change', { bubbles: true }));
 *
 * 这段在真实 Chrome 的招聘页上实测过：文件装进去了，change 事件正常触发，
 * value 回读为 C:\fakepath\简历.pdf。Simplify 那类插件走的也是这条路。
 *
 * jsdom 没有 DataTransfer，也不接受非 FileList 赋给 input.files，所以「造
 * FileList」和「赋值」两步做成可注入接缝，测试里用假实现——单测覆盖的是定位、
 * 解码、派发和上报，那两行的真实行为靠真机验证。
 *
 * 注意上传必须和填写分成两个任务：不少站点解析简历后会把结果覆盖到表单上，
 * 上传完立刻填等于白填。上传 → 等解析 → 重新 inspect → 再填。
 */

import { collectApplicationFields } from './form.js';
import { elementForHandle } from './snapshot.js';

const defaultSeams = {
  makeFileList: (files) => {
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    return dt.files;
  },
  assignFiles: (el, fileList) => { el.files = fileList; },
};

/** base64 还原成 File。缺字段或数据非法一律返回 null，不抛错。 */
export function decodeUpload(upload) {
  if (!upload?.name || typeof upload.dataBase64 !== 'string' || !upload.dataBase64) return null;
  try {
    const binary = atob(upload.dataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], upload.name, { type: upload.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/**
 * 按签名把附件装进对应的文件框。
 *
 * 定位规则跟 fillApplicationFields 一致：签名找不到或有歧义一律跳过，不猜。
 * 传错地方比没传更糟——投出去的简历是别人的，或者根本不是简历。
 */
export function applyFileUploads(root = document, uploads = [], seams = {}) {
  const { makeFileList, assignFiles, snapshotOpts = {} } = { ...defaultSeams, ...seams };
  const uploaded = [];
  const skipped = [];
  if (!Array.isArray(uploads) || uploads.length === 0) return { uploaded, skipped };

  const fields = collectApplicationFields(root);
  const controls = [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !el.disabled && !['hidden', 'submit', 'button', 'reset'].includes((el.getAttribute('type') || '').toLowerCase()));
  const skip = (signature, reason) => skipped.push({ signature, reason });

  for (const upload of uploads) {
    const signature = upload?.signature;
    // 快照句柄优先。inspect / probe / fill 都按快照寻址，上传再用 form.js 的签名
    // 就是第二套寻址——服务端按快照挑中的那个文件框，这里按签名找的是另一个，
    // 轻则找不到、重则把简历传进「作品集」那个框。旧签名留作兼容。
    let el = elementForHandle(root, signature, snapshotOpts);
    if (!el) {
      const matches = fields.filter((field) => field.signature === signature);
      if (matches.length === 0) { skip(signature, 'not_found'); continue; }
      if (matches.length > 1) { skip(signature, 'ambiguous'); continue; }
      el = controls[matches[0].index];
    }
    if (!el) { skip(signature, 'not_found'); continue; }
    if ((el.getAttribute('type') || '').toLowerCase() !== 'file') { skip(signature, 'not_file_input'); continue; }

    const file = decodeUpload(upload);
    if (!file) { skip(signature, 'decode_failed'); continue; }

    try {
      assignFiles(el, makeFileList([file]));
    } catch {
      skip(signature, 'assign_failed');
      continue;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    uploaded.push(signature);
  }

  return { uploaded, skipped };
}
