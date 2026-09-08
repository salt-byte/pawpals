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

/**
 * 收起页面上打开着的浮层。
 *
 * 快照已经会跳过浮层里的东西，但那依赖认得出「什么是浮层」——真机上仍然漏掉过
 * 一类（一轮报 48 个字段，实际 39，多出来的是某个没被选择器覆盖的面板里的选项）。
 * 与其继续往选择器里加 class 名，不如在采快照之前主动把浮层关掉：关掉了就没有
 * 认不认得出的问题。
 *
 * 这是两道防线不是替换：关不掉时，跳过浮层那道还在。
 * 尽力而为，任何异常都不该打断采集。
 */
export function dismissPanels(root = document) {
  try {
    const body = root?.body;
    if (!body) return;
    // 事件要同时打到 document 和 body：很多组件库的「点击外部关闭」监听在
    // document 上，只派给 body 冒泡不上去（或者它们根本没在 body 上挂）。
    // 真机上填完「语言特长」多选后面板始终不关，就是因为只派给了 body。
    const targets = [root, body].filter(Boolean);
    for (const target of targets) {
      target.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
        target.dispatchEvent?.(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    }
  } catch {
    // 收不起来不影响正确性：跳过浮层那道防线还在
  }
}
