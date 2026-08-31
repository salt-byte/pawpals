import { describe, it, expect } from "vitest";
import { planSoulSeed } from "./agent-soul.ts";

const agents = ["career-planner", "resume-expert", "job-hunter"];

const check = (templates: string[], dests: string[]) => ({
  templateExists: (id: string) => templates.includes(id),
  destExists: (id: string) => dests.includes(id),
});

describe("planSoulSeed", () => {
  it("目标工作区为空时，铺全部有模板的 agent", () => {
    const plan = planSoulSeed(agents, check(agents, []));
    expect(plan.map((p) => p.agentId)).toEqual(agents);
  });

  it("已经存在的不覆盖——用户或后续版本改过的内容不能被冲掉", () => {
    const plan = planSoulSeed(agents, check(agents, ["resume-expert"]));
    expect(plan.map((p) => p.agentId)).toEqual(["career-planner", "job-hunter"]);
  });

  it("模板缺失的 agent 跳过，不凭空造文件", () => {
    const plan = planSoulSeed(agents, check(["career-planner"], []));
    expect(plan.map((p) => p.agentId)).toEqual(["career-planner"]);
  });

  it("全部已存在时返回空计划", () => {
    expect(planSoulSeed(agents, check(agents, agents))).toEqual([]);
  });

  it("没有 agent 时返回空计划", () => {
    expect(planSoulSeed([], check(agents, []))).toEqual([]);
  });
});
