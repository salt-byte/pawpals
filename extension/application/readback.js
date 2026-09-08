/**
 * 回读校验：填完之后，用**同一个句柄**把页面上的当前值读回来对一遍。
 *
 * 为什么这是唯一算数的判据：
 *   模型说填了     —— 它看不见页面
 *   fill 返回 ok   —— 只说明赋值语句没抛错
 *   页面读回来对了 —— 这才是真的
 *
 * 真机上三者分家过：合成事件让显示变了、页面内部没提交；signature 和 handle
 * 两套寻址各说各话，「填进去了却被判失败」。所以采集、填写、校验必须共用快照
 * 句柄，一套到底。
 */
import { snapshotControls } from './snapshot.js';

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * 按句柄核对目标值。
 *
 * 三类结果分开报，不混在一起：
 *   confirmed   页面上读回来含有目标值
 *   mismatched  框还在，但值不对（含空着）——这是"没填上"
 *   missing     句柄压根找不到——页面结构变了，跟"没填上"是两回事
 *
 * 用「包含」而不是「相等」：多选控件会显示成「英语雅思7+，日语N2」，日期控件会
 * 补上格式，要求完全相等会把真正填对的判成失败。
 */
export function verifyByHandle(root = document, values = [], opts = {}) {
  const confirmed = [];
  const mismatched = [];
  const missing = [];
  if (!Array.isArray(values) || values.length === 0) return { confirmed, mismatched, missing };

  const byHandle = new Map(snapshotControls(root, opts).map((control) => [control.handle, control]));
  for (const item of values) {
    const control = byHandle.get(item?.signature);
    if (!control) { missing.push(item?.signature); continue; }
    const actual = tidy(control.value);
    const wanted = tidy(item?.value);
    if (wanted && actual.includes(wanted)) confirmed.push(item.signature);
    else mismatched.push({ signature: item.signature, expected: wanted, actual });
  }
  return { confirmed, mismatched, missing };
}
