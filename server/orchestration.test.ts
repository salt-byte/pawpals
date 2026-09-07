import { describe, it, expect } from "vitest";
import { parsePlan, batchByDependency } from "./orchestration.ts";

const VALID = ["job-hunter", "resume-expert", "interview-coach", "app-tracker"];

describe("parsePlan", () => {
  it("解析出正常的多任务计划", () => {
    const raw = '[{"agentId":"job-hunter","task":"搜岗"},{"agentId":"resume-expert","task":"改简历"}]';
    expect(parsePlan(raw, VALID)).toEqual([
      { agentId: "job-hunter", task: "搜岗", dependsOn: [] },
      { agentId: "resume-expert", task: "改简历", dependsOn: [] },
    ]);
  });

  it("剥掉模型爱加的 markdown 围栏", () => {
    const raw = '```json\n[{"agentId":"job-hunter","task":"搜岗"}]\n```';
    expect(parsePlan(raw, VALID)).toHaveLength(1);
  });

  it("null 表示不需要专家，返回空计划", () => {
    expect(parsePlan("null", VALID)).toEqual([]);
  });

  it("非法 JSON 降级为空计划而不是抛错", () => {
    expect(parsePlan("我觉得应该找简历专家", VALID)).toEqual([]);
  });

  it("丢掉不认识的 agentId", () => {
    const raw = '[{"agentId":"产品经理","task":"随便"},{"agentId":"job-hunter","task":"搜岗"}]';
    expect(parsePlan(raw, VALID)).toEqual([{ agentId: "job-hunter", task: "搜岗", dependsOn: [] }]);
  });

  it("丢掉 task 为空的项", () => {
    const raw = '[{"agentId":"job-hunter","task":"  "},{"agentId":"resume-expert","task":"改简历"}]';
    expect(parsePlan(raw, VALID)).toEqual([{ agentId: "resume-expert", task: "改简历", dependsOn: [] }]);
  });

  it("同一个 agent 出现两次时只留第一次", () => {
    const raw = '[{"agentId":"job-hunter","task":"搜岗"},{"agentId":"job-hunter","task":"再搜一次"}]';
    expect(parsePlan(raw, VALID)).toEqual([{ agentId: "job-hunter", task: "搜岗", dependsOn: [] }]);
  });

  it("dependsOn 指向计划外的 agent 时，丢掉那条依赖而不是整个计划", () => {
    const raw = '[{"agentId":"resume-expert","task":"改简历","dependsOn":["networker"]}]';
    expect(parsePlan(raw, VALID)).toEqual([{ agentId: "resume-expert", task: "改简历", dependsOn: [] }]);
  });

  it("依赖成环时整个计划作废", () => {
    const raw = '[{"agentId":"job-hunter","task":"a","dependsOn":["resume-expert"]},'
      + '{"agentId":"resume-expert","task":"b","dependsOn":["job-hunter"]}]';
    expect(parsePlan(raw, VALID)).toEqual([]);
  });
});

describe("batchByDependency", () => {
  it("没有依赖的任务全在第一批", () => {
    const tasks = [
      { agentId: "job-hunter", task: "搜岗", dependsOn: [] },
      { agentId: "resume-expert", task: "改简历", dependsOn: [] },
    ];
    expect(batchByDependency(tasks)).toEqual([tasks]);
  });

  it("有依赖的任务排进后一批", () => {
    const hunter = { agentId: "job-hunter", task: "搜岗", dependsOn: [] };
    const resume = { agentId: "resume-expert", task: "按岗位改简历", dependsOn: ["job-hunter"] };
    expect(batchByDependency([resume, hunter])).toEqual([[hunter], [resume]]);
  });

  it("链式依赖分成三批", () => {
    const a = { agentId: "job-hunter", task: "a", dependsOn: [] };
    const b = { agentId: "resume-expert", task: "b", dependsOn: ["job-hunter"] };
    const c = { agentId: "interview-coach", task: "c", dependsOn: ["resume-expert"] };
    expect(batchByDependency([c, b, a])).toEqual([[a], [b], [c]]);
  });

  it("成环返回 null", () => {
    const a = { agentId: "job-hunter", task: "a", dependsOn: ["resume-expert"] };
    const b = { agentId: "resume-expert", task: "b", dependsOn: ["job-hunter"] };
    expect(batchByDependency([a, b])).toBeNull();
  });

  it("空计划返回空批次", () => {
    expect(batchByDependency([])).toEqual([]);
  });
});
