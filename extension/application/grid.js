/**
 * 表格（子表单）里的格子，标签在列头上。
 *
 * 真机（简道云 .fx-subform）：获奖经历、社团干部经历、实习经历、项目经历都是
 * 子表单，每个格子周围一个字都没有。「向上找标题」那套在这里完全失效——快照给
 * 模型的 context 要么是空的、要么是行号「1」，于是这几张表一个字段都填不了。
 *
 * 结构是规整的，而且不只简道云一家这么排：
 *   容器
 *     列头行（class 里有 head/header）  > 格子 > 标题
 *     数据行                            > 格子 > 控件
 *
 * 靠类名提示识别，不绑定任何一家的具体 class。对不上就返回空串——**宁可没有
 * 标签，也不能给错标签**：给错了模型会拿别的列的语义去填这一列，比空着更糟。
 */

const CELL_HINT = /cell|col(umn)?\b|td/i;
const HEAD_HINT = /head|header|title|th\b/i;
const ROW_HINT = /row|tr\b/i;

const cls = (el) => String(el?.className || '');
const tidy = (text) => String(text || '').replace(/\s+/g, ' ').trim();
/** 去掉必填星号：列头写的是「*获奖类型」，标签是「获奖类型」。 */
const stripMark = (text) => tidy(text).replace(/^[*＊]\s*/, '');

/** 往上找第一个像「格子」的祖先。 */
function cellOf(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    if (CELL_HINT.test(cls(node))) return node;
    if (HEAD_HINT.test(cls(node))) return null; // 已经走进列头区，说明这不是数据格
  }
  return null;
}

/** 往上找包住格子的那一行。 */
function rowOf(cell) {
  for (let node = cell?.parentElement; node; node = node.parentElement) {
    if (ROW_HINT.test(cls(node))) return node;
  }
  return null;
}

/**
 * 这一行里，格子的序号。
 *
 * 只数像格子的兄弟：数据行前后常挂着 .error-tip-row、.row-head 这类杂项，
 * 用 children 的原始下标会整体错位一格。
 */
function indexInRow(row, cell) {
  const cells = [...row.children].filter((node) => CELL_HINT.test(cls(node)));
  return cells.indexOf(cell);
}

/** 表格容器里的列头文案。找不到返回空数组。 */
function headerTitles(row) {
  // 从数据行往上找表格容器，再在里面找列头区
  for (let table = row.parentElement; table; table = table.parentElement) {
    const head = [...table.children].find((node) => HEAD_HINT.test(cls(node)));
    if (!head) continue;
    const cells = [...head.querySelectorAll('*')].filter(
      (node) => CELL_HINT.test(cls(node)) && !node.querySelector(`[class*="cell"]`)
    );
    if (cells.length) return cells.map((node) => stripMark(node.textContent));
  }
  return [];
}

/**
 * 控件所在格子对应的列头文案。不在表格里、或对不上号时返回空串。
 */
export function gridHeaderFor(el) {
  if (!el) return '';
  const cell = cellOf(el);
  if (!cell) return '';
  const row = rowOf(cell);
  if (!row) return '';
  const index = indexInRow(row, cell);
  if (index < 0) return '';
  const titles = headerTitles(row);
  // 数量对不上说明这张表的排布跟假设不同。给错标签比没有标签更糟——模型会拿
  // 别的列的语义去填这一列。
  if (titles.length === 0 || index >= titles.length) return '';
  return titles[index];
}
