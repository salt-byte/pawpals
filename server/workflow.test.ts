import { describe, it, expect } from "vitest";
import {
  WORKFLOW_STAGES,
  stageLabel,
  stageIndex,
  nextStage,
  isAtLeast,
} from "./workflow.ts";

describe("WORKFLOW_STAGES", () => {
  it("按岗位实际推进顺序排列", () => {
    expect(WORKFLOW_STAGES.map((s) => s.id)).toEqual([
      "new",
      "selected",
      "tailoring",
      "apply_ready",
      "applied",
    ]);
  });
});

describe("stageLabel", () => {
  it("返回中文label", () => {
    expect(stageLabel("tailoring")).toBe("定制中");
    expect(stageLabel("apply_ready")).toBe("待投递");
  });

  it("未知阶段原样返回，不抛错", () => {
    expect(stageLabel("something-else" as any)).toBe("something-else");
  });

  it("空值返回未记录", () => {
    expect(stageLabel("" as any)).toBe("未记录");
  });
});

describe("stageIndex", () => {
  it("返回阶段在流程中的位置", () => {
    expect(stageIndex("new")).toBe(0);
    expect(stageIndex("applied")).toBe(4);
  });

  it("未知阶段返回 -1", () => {
    expect(stageIndex("nope" as any)).toBe(-1);
  });
});

describe("nextStage", () => {
  it("返回下一个阶段", () => {
    expect(nextStage("new")).toBe("selected");
    expect(nextStage("tailoring")).toBe("apply_ready");
  });

  it("终点没有下一个阶段", () => {
    expect(nextStage("applied")).toBeNull();
  });

  it("未知阶段返回 null", () => {
    expect(nextStage("nope" as any)).toBeNull();
  });
});

describe("isAtLeast", () => {
  it("判断是否已推进到某阶段或更靠后", () => {
    expect(isAtLeast("apply_ready", "tailoring")).toBe(true);
    expect(isAtLeast("tailoring", "tailoring")).toBe(true);
    expect(isAtLeast("selected", "apply_ready")).toBe(false);
  });

  it("任一侧是未知阶段时返回 false，不做危险的推断", () => {
    expect(isAtLeast("nope" as any, "tailoring")).toBe(false);
    expect(isAtLeast("applied", "nope" as any)).toBe(false);
  });
});
