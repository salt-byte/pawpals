import { describe, it, expect } from "vitest";
import { TAILOR_BEATS, runTailorPipeline, type TailorDeps } from "./tailor-pipeline.ts";
import type { JobRow, BoardRowLike } from "./job-pipeline.ts";

const row: JobRow = {
  company: "字节跳动",
  role: "AI产品经理",
  jdUrl: "https://example.com/job/1",
};

/**
 * 记录驱动器对外做了哪些动作。全部是我们自己的接缝，不是第三方库的 mock——
 * 断言的是「驱动器按什么顺序调了谁」，这正是这一层的职责。
 */
function spyDeps(overrides: Partial<TailorDeps> = {}) {
  const calls: string[] = [];
  const prompts: Array<{ agentId: string; prompt: string }> = [];
  const announcements: Array<{ agentId: string; text: string }> = [];
  const stages: string[] = [];
  const deps: TailorDeps = {
    setStage: (_row, stage) => { stages.push(stage); calls.push(`stage:${stage}`); },
    fetchJdContent: async (url) => { calls.push(`fetchJd:${url}`); return "JD 正文原文"; },
    announce: (agentId, text) => { announcements.push({ agentId, text }); calls.push(`announce:${agentId}`); },
    runBeat: async (agentId, prompt) => { prompts.push({ agentId, prompt }); calls.push(`beat:${agentId}`); },
    readRow: () => undefined,
    ...overrides,
  };
  return { deps, calls, prompts, announcements, stages };
}

const boardRow = (patch: Partial<NonNullable<BoardRowLike>>) => () => patch;

describe("TAILOR_BEATS 配置表", () => {
  it("两拍：先专业老师拆 JD，再简历专家定制", () => {
    expect(TAILOR_BEATS.map((b) => b.agentId)).toEqual([
      "professional-teacher",
      "resume-expert",
    ]);
  });

  it("只有拆 JD 那一拍需要 JD 正文", () => {
    expect(TAILOR_BEATS.filter((b) => b.needsJdContent).map((b) => b.agentId)).toEqual([
      "professional-teacher",
    ]);
  });
});

describe("runTailorPipeline", () => {
  it("按配置表顺序把每一拍交给对应的角色", async () => {
    const { deps, prompts } = spyDeps();
    await runTailorPipeline(row, "团团", deps);
    expect(prompts.map((p) => p.agentId)).toEqual([
      "professional-teacher",
      "resume-expert",
    ]);
  });

  it("开跑前先把阶段落成 tailoring——中途崩了也看得出它卡在定制中", async () => {
    const { deps, calls } = spyDeps();
    await runTailorPipeline(row, "团团", deps);
    expect(calls[0]).toBe("stage:tailoring");
  });

  it("有 jdUrl 时先播报再抓取，抓到的正文进了第一拍的 prompt", async () => {
    const { deps, calls, prompts, announcements } = spyDeps();
    await runTailorPipeline(row, "团团", deps);

    expect(calls.slice(0, 4)).toEqual([
      "stage:tailoring",
      "announce:professional-teacher",
      "fetchJd:https://example.com/job/1",
      "beat:professional-teacher",
    ]);
    expect(announcements[0].text).toContain("字节跳动");
    expect(prompts[0].prompt).toContain("JD 正文原文");
  });

  it("没有 jdUrl 时不播报也不抓取，直接开跑", async () => {
    const { deps, calls } = spyDeps();
    await runTailorPipeline({ company: "腾讯", role: "PM" }, "团团", deps);
    expect(calls).not.toContain("announce:professional-teacher");
    expect(calls.some((c) => c.startsWith("fetchJd:"))).toBe(false);
    expect(calls[1]).toBe("beat:professional-teacher");
  });

  it("JD 只抓一次，第二拍不重复抓", async () => {
    const { deps, calls } = spyDeps();
    await runTailorPipeline(row, "团团", deps);
    expect(calls.filter((c) => c.startsWith("fetchJd:"))).toHaveLength(1);
  });

  it("两个专家都回写了就结算成 apply_ready", async () => {
    const { deps, stages } = spyDeps({
      readRow: boardRow({ skillHighlights: "强调A/B测试", resumeVersion: "v2.1-字节跳动" }),
    });
    const settled = await runTailorPipeline(row, "团团", deps);
    expect(settled).toBe("apply_ready");
    expect(stages).toEqual(["tailoring", "apply_ready"]);
  });

  it("有人没回写就留在 tailoring——读不到产出不等于做完了", async () => {
    const { deps, stages } = spyDeps({
      readRow: boardRow({ skillHighlights: "强调A/B测试" }),
    });
    const settled = await runTailorPipeline(row, "团团", deps);
    expect(settled).toBe("tailoring");
    expect(stages).toEqual(["tailoring", "tailoring"]);
  });

  it("结算读的是跑完之后的行，不是开跑前的快照", async () => {
    let finished = false;
    const { deps, stages } = spyDeps({
      runBeat: async () => { finished = true; },
      readRow: () => (finished ? { skillHighlights: "要点", resumeVersion: "v2.1-字节跳动" } : {}),
    });
    await runTailorPipeline(row, "团团", deps);
    expect(stages[1]).toBe("apply_ready");
  });
});
