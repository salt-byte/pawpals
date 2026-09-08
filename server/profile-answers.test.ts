import { describe, it, expect } from "vitest";
import { upsertAnswers, parseAnswers, ANSWERS_HEADING } from "./profile-answers.ts";

/**
 * 「问一次，以后都记得」。
 *
 * 真机：每投一张表都会问同样几个——民族、学号、出生年月、是否接受岗位调剂、
 * 出差意向。前三个档案里确实没有，后两个问的是**意愿**而不是事实（简历不会写
 * 「我接受调剂」），模型拒绝替用户表态是对的：编一个上去等于替他答应了没答应的事。
 *
 * 但每次都问，就没解决产品最初要解决的那个痛点——「求职信息需要反复填写」。
 * 答案存进 profile.md，下一张表自动就有了（readAutofillProfileText 本来就在读它）。
 *
 * 存储必须是加性的：profile.md 里已经有 onboarding 写的搜岗偏好，不能覆盖掉。
 */
describe("upsertAnswers", () => {
  const existing = "# 用户档案\n\n方向: AI 产品经理\n城市: 北京\n";

  it("在已有档案后面加一节，不动原来的内容", () => {
    const out = upsertAnswers(existing, { 民族: "汉族", 学号: "无" });
    expect(out).toContain("方向: AI 产品经理");
    expect(out).toContain(ANSWERS_HEADING);
    expect(out).toContain("民族: 汉族");
    expect(out).toContain("学号: 无");
  });

  it("再次回答同一个字段就更新，不重复追加", () => {
    const once = upsertAnswers(existing, { 民族: "汉族" });
    const twice = upsertAnswers(once, { 民族: "满族" });
    expect(twice).toContain("民族: 满族");
    expect(twice).not.toContain("民族: 汉族");
    expect(twice.match(/民族:/g)).toHaveLength(1);
  });

  it("新答案和老答案共存", () => {
    const once = upsertAnswers(existing, { 民族: "汉族" });
    const twice = upsertAnswers(once, { 出差意向: "接受偶尔出差" });
    expect(twice).toContain("民族: 汉族");
    expect(twice).toContain("出差意向: 接受偶尔出差");
  });

  it("档案为空时也能建起来", () => {
    expect(upsertAnswers("", { 学号: "无" })).toContain("学号: 无");
  });

  it("空答案不写进去——留空和答「无」是两回事", () => {
    const out = upsertAnswers(existing, { 民族: "", 学号: "无" });
    expect(out).not.toContain("民族:");
    expect(out).toContain("学号: 无");
  });

  it("答案里的换行会被压平，不破坏一行一项的格式", () => {
    const out = upsertAnswers(existing, { 出差意向: "接受\n偶尔出差" });
    expect(out).toContain("出差意向: 接受 偶尔出差");
  });
});

describe("parseAnswers", () => {
  it("读得回自己写的", () => {
    const text = upsertAnswers("", { 民族: "汉族", 出差意向: "接受偶尔出差" });
    expect(parseAnswers(text)).toEqual({ 民族: "汉族", 出差意向: "接受偶尔出差" });
  });

  it("没有这一节时返回空", () => {
    expect(parseAnswers("# 用户档案\n方向: AI 产品经理")).toEqual({});
  });
});
