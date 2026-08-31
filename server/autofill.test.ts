import { describe, it, expect } from "vitest";
import { splitName, pickAutofillValue } from "./autofill.ts";

const profile = {
  name: "邓雨蝶",
  email: "yudieden@usc.edu",
  phone: "13800000000",
  linkedin: "https://linkedin.com/in/example",
  portfolio: "https://example.com",
};

const field = (kind: string, label = "") => ({ kind, label, index: 0 });

describe("splitName", () => {
  it("中文名：首字为姓，其余为名", () => {
    expect(splitName("邓雨蝶")).toEqual({ first: "雨蝶", last: "邓" });
  });

  it("中文复姓识别为两字姓", () => {
    expect(splitName("欧阳雨蝶")).toEqual({ first: "雨蝶", last: "欧阳" });
  });

  it("两字中文名", () => {
    expect(splitName("李雷")).toEqual({ first: "雷", last: "李" });
  });

  it("英文名：最后一段为姓", () => {
    expect(splitName("Yudie Deng")).toEqual({ first: "Yudie", last: "Deng" });
  });

  it("英文中间名归入 first", () => {
    expect(splitName("Mary Jane Watson")).toEqual({ first: "Mary Jane", last: "Watson" });
  });

  it("单个词时不臆造姓", () => {
    expect(splitName("Madonna")).toEqual({ first: "Madonna", last: "" });
  });

  it("空值安全", () => {
    expect(splitName("")).toEqual({ first: "", last: "" });
    expect(splitName("   ")).toEqual({ first: "", last: "" });
  });
});

describe("pickAutofillValue", () => {
  const ctx = { title: "AI 产品经理实习生", company: "字节跳动" };

  it("first_name 填名，不是全名", () => {
    expect(pickAutofillValue(field("first_name"), profile, ctx)).toBe("雨蝶");
  });

  it("last_name 填姓，不是全名", () => {
    expect(pickAutofillValue(field("last_name"), profile, ctx)).toBe("邓");
  });

  it("full_name 才填全名", () => {
    expect(pickAutofillValue(field("full_name"), profile, ctx)).toBe("邓雨蝶");
  });

  it("邮箱 / 电话 / linkedin / 作品集按 kind 取值", () => {
    expect(pickAutofillValue(field("email"), profile, ctx)).toBe(profile.email);
    expect(pickAutofillValue(field("phone"), profile, ctx)).toBe(profile.phone);
    expect(pickAutofillValue(field("linkedin"), profile, ctx)).toBe(profile.linkedin);
    expect(pickAutofillValue(field("portfolio"), profile, ctx)).toBe(profile.portfolio);
  });

  it("求职信带上公司与岗位", () => {
    const out = pickAutofillValue(field("cover_letter"), profile, ctx);
    expect(out).toContain("字节跳动");
    expect(out).toContain("AI 产品经理实习生");
  });

  it("简历附件、验证码、敏感问题一律不自动填", () => {
    for (const kind of ["resume", "verification", "sensitive_demographic"]) {
      expect(pickAutofillValue(field(kind), profile, ctx)).toBe("");
    }
  });

  it("无法归类的自定义字段留空，不猜", () => {
    expect(pickAutofillValue(field("custom", "你为什么想来我们公司"), profile, ctx)).toBe("");
  });

  it("档案里没有该项时留空，不填占位符", () => {
    const empty = { name: "", email: "", phone: "", linkedin: "", portfolio: "" };
    expect(pickAutofillValue(field("email"), empty, ctx)).toBe("");
    expect(pickAutofillValue(field("first_name"), empty, ctx)).toBe("");
  });
});
