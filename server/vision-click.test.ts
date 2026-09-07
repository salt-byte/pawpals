import { describe, it, expect } from "vitest";
import { buildVisionPrompt, parseVisionClick } from "./vision-click.ts";

/**
 * 视觉兜底：截图 → 模型给坐标 → CDP 在坐标上点。
 *
 * 读了 Claude in Chrome 的实现，它的主路径就是这个（coordinate 出现 136 次，
 * ref 只有 34 次）。视觉路线对「不做无障碍的表单」天然免疫——简道云的下拉没有
 * ARIA role、选项是无 class 的 span，这些让结构化解析处处碰壁的东西，在截图里
 * 就是一个写着「学历」的框。
 *
 * 但模型给的坐标不能照单全收：它可能点到别的字段、点到提交按钮。所以坐标必须
 * 落在目标控件的框内——这跟 signature 寻址、options 校验是同一类机械约束。
 */
describe("buildVisionPrompt", () => {
  it("说明要点什么，并给出目标框的位置", () => {
    const prompt = buildVisionPrompt({ label: "学历", box: { x: 10, y: 20, width: 100, height: 32 } });
    expect(prompt).toContain("学历");
    expect(prompt).toContain("10");
    expect(prompt).toContain("32");
  });

  it("要求只返回坐标，不要解释", () => {
    const prompt = buildVisionPrompt({ label: "学历", box: { x: 0, y: 0, width: 10, height: 10 } });
    expect(prompt.toLowerCase()).toContain("json");
  });
});

describe("parseVisionClick", () => {
  const box = { x: 100, y: 200, width: 300, height: 40 };

  it("接受落在目标框内的坐标", () => {
    expect(parseVisionClick({ x: 250, y: 220 }, box)).toEqual({ ok: true, x: 250, y: 220 });
  });

  it("拒绝框外的坐标——模型可能点到别的字段甚至提交按钮", () => {
    expect(parseVisionClick({ x: 250, y: 900 }, box)).toMatchObject({ ok: false, reason: "outside_target" });
  });

  it("边界上算框内", () => {
    expect(parseVisionClick({ x: 100, y: 200 }, box).ok).toBe(true);
    expect(parseVisionClick({ x: 400, y: 240 }, box).ok).toBe(true);
  });

  it("缺字段或不是数字一律拒绝", () => {
    expect(parseVisionClick({ x: "250", y: 220 } as any, box).ok).toBe(false);
    expect(parseVisionClick({ y: 220 } as any, box).ok).toBe(false);
    expect(parseVisionClick(null, box).ok).toBe(false);
  });

  it("NaN 和 Infinity 拒绝", () => {
    expect(parseVisionClick({ x: NaN, y: 220 }, box).ok).toBe(false);
    expect(parseVisionClick({ x: Infinity, y: 220 }, box).ok).toBe(false);
  });

  it("没有给目标框时拒绝——无从校验就不放行", () => {
    expect(parseVisionClick({ x: 1, y: 1 }, undefined as any).ok).toBe(false);
  });
});
