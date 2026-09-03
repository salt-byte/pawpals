import { describe, it, expect } from "vitest";
import { splitName, pickAutofillValue , parseAutofillProfile } from "./autofill.ts";

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

/**
 * 真机踩到：saveInitialResumeMaster 写出的文件第一行永远是 `# 原始简历`，而
 * extractAutofillProfile 的姓名正则是 /^#\s*(.+)$/m ——只要 profile.md 里还没有
 * 「姓名：」，姓名就会被解析成「原始简历」并填进雇主的申请表。
 */
describe("parseAutofillProfile", () => {
  const RESUME_HEADER = "# 原始简历\n\n来源文件: 简历.pdf\n\n## 提取文本\n\n";

  it("优先用显式的「姓名：」标注", () => {
    const text = `姓名：邓雨蝶\n邮箱：a@b.com`;
    expect(parseAutofillProfile(text).name).toBe("邓雨蝶");
  });

  it("没有标注时取正文第一行，不能把模板标题当名字", () => {
    const text = `${RESUME_HEADER}邓雨蝶\n手机：15996610829\n邮箱：290277166@qq.com`;
    const profile = parseAutofillProfile(text);
    expect(profile.name).toBe("邓雨蝶");
    expect(profile.name).not.toBe("原始简历");
  });

  it("模板里的固定标题一律不作为姓名", () => {
    for (const heading of ["原始简历", "提取文本", "教育经历", "实习经历", "项目经历"]) {
      expect(parseAutofillProfile(`# ${heading}\n\n无正文`).name).not.toBe(heading);
    }
  });

  it("正文第一行不像名字时宁可留空——填错名字比不填更糟", () => {
    const text = `${RESUME_HEADER}15996610829 | 290277166@qq.com | 个人主页`;
    expect(parseAutofillProfile(text).name).toBe("");
  });

  it("邮箱和手机照常提取", () => {
    const text = `${RESUME_HEADER}邓雨蝶\n手机：15996610829\n邮箱：290277166@qq.com`;
    const profile = parseAutofillProfile(text);
    expect(profile.email).toBe("290277166@qq.com");
    expect(profile.phone).toBe("15996610829");
  });

  it("空档案时全部留空，不编造", () => {
    expect(parseAutofillProfile("")).toMatchObject({ name: "", email: "", phone: "" });
  });
});
