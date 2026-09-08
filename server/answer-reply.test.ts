import { describe, it, expect } from "vitest";
import { parseUserAnswers } from "./answer-reply.ts";

/**
 * 从用户的一句回复里认出他答了哪些字段。
 *
 * 我们问的时候列的是「· 民族（必填）」「· 出差意向（必填）：接受 / 不接受」，
 * 用户回过来多半是随手一行行写，或者一句话里带几个。认出来才能存进档案，
 * 下一张表就不用再问——「求职信息反复填写」正是这个产品要解决的痛点。
 *
 * 认不出的一律不猜：存错了比不存更糟，那会变成一条假信息跟着他投出去。
 */
describe("parseUserAnswers", () => {
  const asked = ["民族", "学号", "出生年月", "是否接受岗位调剂", "出差意向"];

  it("一行一个", () => {
    const text = "民族：汉族\n学号：2024310123\n出差意向：接受偶尔出差";
    expect(parseUserAnswers(text, asked)).toEqual({
      民族: "汉族", 学号: "2024310123", 出差意向: "接受偶尔出差",
    });
  });

  it("用等号或空格分隔也认", () => {
    expect(parseUserAnswers("民族 = 汉族\n学号 2024310123", asked)).toMatchObject({
      民族: "汉族", 学号: "2024310123",
    });
  });

  it("一句话里带几个也认", () => {
    const out = parseUserAnswers("民族汉族，是否接受岗位调剂：接受", asked);
    expect(out["是否接受岗位调剂"]).toBe("接受");
  });

  it("没问过的字段不收——只认我们问过的那几个", () => {
    expect(parseUserAnswers("血型：A型\n民族：汉族", asked)).toEqual({ 民族: "汉族" });
  });

  it("认不出就返回空，不猜", () => {
    expect(parseUserAnswers("好的，你继续", asked)).toEqual({});
  });

  it("空回复不炸", () => {
    expect(parseUserAnswers("", asked)).toEqual({});
    expect(parseUserAnswers("民族：汉族", [])).toEqual({});
  });

  it("答案里带标点不会被截断", () => {
    expect(parseUserAnswers("出差意向：可以接受每月1-2次短期出差", asked)["出差意向"])
      .toBe("可以接受每月1-2次短期出差");
  });
});
