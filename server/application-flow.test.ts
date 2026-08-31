import { describe, it, expect } from "vitest";
import { planApplicationStep } from "./application-flow.ts";

describe("planApplicationStep", () => {
  it("页面需要先上传简历时，先不填任何字段", () => {
    const plan = planApplicationStep({
      ok: true,
      warnings: ["resume_requires_user_file_selection"],
      fields: [{ kind: "email", signature: "s1" }],
    });
    expect(plan.action).toBe("await_resume_upload");
  });

  it("简历已上传后才进入填写", () => {
    const plan = planApplicationStep({
      ok: true,
      warnings: [],
      fields: [{ kind: "email", signature: "s1" }],
    });
    expect(plan.action).toBe("fill");
  });

  it("页面本来就没有简历附件字段时直接填写", () => {
    const plan = planApplicationStep({
      ok: true,
      warnings: ["verification_required"],
      fields: [{ kind: "phone", signature: "s2" }],
    });
    expect(plan.action).toBe("fill");
  });

  it("检查失败时不推进，把原因带出来", () => {
    const plan = planApplicationStep({ ok: false, error: "页面无法访问" });
    if (plan.action !== "abort") throw new Error(`预期 abort，实际 ${plan.action}`);
    expect(plan.reason).toContain("页面无法访问");
  });

  it("inspect 结果缺失也当作失败，不当成空表单往下走", () => {
    expect(planApplicationStep(null).action).toBe("abort");
    expect(planApplicationStep(undefined).action).toBe("abort");
  });

  it("字段列表缺失时按空表单处理，不抛错", () => {
    const plan = planApplicationStep({ ok: true });
    if (plan.action !== "fill") throw new Error(`预期 fill，实际 ${plan.action}`);
    expect(plan.fields).toEqual([]);
  });
});
