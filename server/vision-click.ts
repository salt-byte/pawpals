/**
 * 视觉兜底的服务端半边：给模型一张截图，让它说「点这里」。
 *
 * 为什么需要它：简道云那张表 39 个字段里，14 个是 div 拼的下拉——没有 ARIA
 * role、选项是无 class 的 span、label 藏在容器里。结构化解析在这类表单上是逐个
 * 打补丁，每换一家表单就重来一遍。截图不吃这一套：写着「学历」的框在图里就是
 * 一个框。
 *
 * 但坐标是危险的输出——模型点错地方，可能点到「提交」。所以这里只做一件事：
 * 把模型的坐标钉死在目标控件的框内。越界一律拒绝，宁可退回让用户填。
 * 这和 signature 寻址、options 校验、source-must-contain-value 是同一类约束：
 * 不指望模型自律，用机械规则兜住。
 */
export type ViewportBox = { x: number; y: number; width: number; height: number };

export type VisionClickResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

export function buildVisionPrompt(input: { label: string; box: ViewportBox; hint?: string }): string {
  const { label, box, hint } = input;
  const lines = [
    "你在看一张网页表单的截图（视口坐标，左上角为原点，单位是 CSS 像素）。",
    `目标控件：「${label}」，它的位置是 x=${box.x} y=${box.y} 宽=${box.width} 高=${box.height}。`,
    hint ? `要做的事：${hint}` : "要做的事：点开这个控件。",
    "只返回 JSON，形如 {\"x\": 数字, \"y\": 数字}，不要解释、不要 markdown 代码块。",
    "坐标必须落在上面给的框内——落到别处的答案会被丢弃。",
  ];
  return lines.join("\n");
}

const isFinitePlainNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function parseVisionClick(raw: unknown, box: ViewportBox | undefined): VisionClickResult {
  if (!box || !isFinitePlainNumber(box.x) || !isFinitePlainNumber(box.y)) {
    // 没有框就没法校验。与其放行一个无从验证的坐标，不如判失败。
    return { ok: false, reason: "no_target_box" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "malformed" };
  const { x, y } = raw as { x?: unknown; y?: unknown };
  if (!isFinitePlainNumber(x) || !isFinitePlainNumber(y)) return { ok: false, reason: "malformed" };

  const right = box.x + (isFinitePlainNumber(box.width) ? box.width : 0);
  const bottom = box.y + (isFinitePlainNumber(box.height) ? box.height : 0);
  // 边界算框内：控件边缘上的点击是有效的
  if (x < box.x || x > right || y < box.y || y > bottom) return { ok: false, reason: "outside_target" };

  return { ok: true, x, y };
}
