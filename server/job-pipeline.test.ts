import { describe, it, expect } from "vitest";
import {
  companySlug,
  boardTarget,
  skillUpdatePayload,
  resumeUpdatePayload,
  jdAnalysisPrompt,
  tailorPrompt,
  canEnterApplyReady,
} from "./job-pipeline.ts";

const row = {
  company: "Anthropic",
  role: "AI Product Manager Intern",
  jdUrl: "https://example.com/job/1",
  location: "San Francisco",
  salary: "$50/hr",
};

describe("companySlug", () => {
  it("英文公司名转成小写连字符", () => {
    expect(companySlug("Anthropic")).toBe("anthropic");
    expect(companySlug("Acme Corp. Ltd")).toBe("acme-corp-ltd");
  });

  it("首尾连字符会被去掉", () => {
    expect(companySlug("  Acme!  ")).toBe("acme");
  });

  it("空公司名退化为 company", () => {
    expect(companySlug("")).toBe("company");
  });

  it("已知缺陷：纯中文公司名也退化为 company，导致简历版本号无法区分岗位", () => {
    expect(companySlug("字节跳动")).toBe("company");
  });
});

describe("协作表格载荷", () => {
  it("boardTarget 只带定位用的三个字段", () => {
    expect(JSON.parse(boardTarget(row))).toEqual({
      company: "Anthropic", role: "AI Product Manager Intern", jdUrl: "https://example.com/job/1",
    });
  });

  it("jdUrl 缺失时补空串，不是 undefined", () => {
    expect(JSON.parse(boardTarget({ ...row, jdUrl: "" })).jdUrl).toBe("");
  });

  it("skillUpdatePayload 带 skillHighlights 占位说明", () => {
    expect(JSON.parse(skillUpdatePayload(row))).toHaveProperty("skillHighlights");
  });

  it("resumeUpdatePayload 的版本号带上公司标识", () => {
    expect(JSON.parse(resumeUpdatePayload(row)).resumeVersion).toBe("v2.1-anthropic");
  });

  it("载荷是紧凑单行 JSON——BOARD_UPDATE 协议按行扫描，换行会解析失败", () => {
    for (const payload of [boardTarget(row), skillUpdatePayload(row), resumeUpdatePayload(row)]) {
      expect(payload).not.toContain("\n");
    }
  });
});

describe("jdAnalysisPrompt", () => {
  it("带上公司、岗位、地点、薪资", () => {
    const out = jdAnalysisPrompt({ row, petName: "团团", jdContent: "" });
    expect(out).toContain("Anthropic");
    expect(out).toContain("AI Product Manager Intern");
    expect(out).toContain("San Francisco");
    expect(out).toContain("$50/hr");
  });

  it("抓到 JD 正文时带上正文，并截断超长内容", () => {
    const out = jdAnalysisPrompt({ row, petName: "团团", jdContent: "岗".repeat(5000) });
    expect(out).toContain("【JD 正文】");
    expect(out).not.toContain("岗".repeat(3001));
  });

  it("没抓到 JD 正文时说明情况，而不是留空让模型以为没有要求", () => {
    const out = jdAnalysisPrompt({ row, petName: "团团", jdContent: "" });
    expect(out).not.toContain("【JD 正文】");
    expect(out).toContain("未能抓取");
  });

  it("结尾要求追加 BOARD_UPDATE 行", () => {
    const out = jdAnalysisPrompt({ row, petName: "团团", jdContent: "" });
    expect(out).toContain("BOARD_UPDATE::");
  });
});

describe("tailorPrompt", () => {
  it("带上公司岗位与版本号格式要求", () => {
    const out = tailorPrompt({ row, petName: "团团" });
    expect(out).toContain("Anthropic");
    expect(out).toContain("v2.1-anthropic");
    expect(out).toContain("BOARD_UPDATE::");
  });
});

describe("canEnterApplyReady", () => {
  it("技能要点与简历版本都齐了才算够格进待投递", () => {
    expect(canEnterApplyReady({ skillHighlights: "强调A/B测试", resumeVersion: "v2.1-anthropic" })).toBe(true);
  });

  it("缺任意一项都不放行", () => {
    expect(canEnterApplyReady({ skillHighlights: "强调A/B测试", resumeVersion: "" })).toBe(false);
    expect(canEnterApplyReady({ skillHighlights: "", resumeVersion: "v2.1-anthropic" })).toBe(false);
  });

  it("行不存在时不放行，而不是当成通过", () => {
    expect(canEnterApplyReady(undefined)).toBe(false);
    expect(canEnterApplyReady(null)).toBe(false);
  });

  it("只有空白字符不算填了", () => {
    expect(canEnterApplyReady({ skillHighlights: "   ", resumeVersion: "v2.1-x" })).toBe(false);
  });
});
