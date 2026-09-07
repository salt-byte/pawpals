import { describe, it, expect } from "vitest";
import { parsePlan, batchByDependency, buildAgentPrompt, buildTurnHistory, parseNeedMore } from "./orchestration.ts";

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

describe("buildAgentPrompt", () => {
  const base = { history: [], profile: "", turnLog: [], task: "帮我改简历" };

  it("任务本身一定在", () => {
    expect(buildAgentPrompt(base)).toContain("帮我改简历");
  });

  it("把本轮伙伴的产出拼进去 —— 这是「协作」的唯一落点", () => {
    const prompt = buildAgentPrompt({
      ...base,
      turnLog: [{ agentId: "job-hunter", agentName: "岗位猎手", task: "搜岗", reply: "找到 3 个岗位：A/B/C" }],
    });
    expect(prompt).toContain("岗位猎手");
    expect(prompt).toContain("找到 3 个岗位：A/B/C");
  });

  it("多条产出按顺序全部拼进去", () => {
    const prompt = buildAgentPrompt({
      ...base,
      turnLog: [
        { agentId: "job-hunter", agentName: "岗位猎手", task: "搜岗", reply: "岗位 A" },
        { agentId: "resume-expert", agentName: "简历专家", task: "改简历", reply: "简历 v2" },
      ],
    });
    expect(prompt.indexOf("岗位 A")).toBeLessThan(prompt.indexOf("简历 v2"));
  });

  it("带上真实对话历史，用户和助手都要区分得出来", () => {
    const prompt = buildAgentPrompt({
      ...base,
      history: [
        { role: "user", content: "我想找产品岗" },
        { role: "assistant", content: "好的，我先了解一下你的背景", name: "团团" },
      ],
    });
    expect(prompt).toContain("我想找产品岗");
    expect(prompt).toContain("团团");
  });

  it("档案为空时不留下空标题", () => {
    expect(buildAgentPrompt(base)).not.toContain("【用户档案与简历】");
  });

  it("TurnLog 为空时不留下空标题", () => {
    expect(buildAgentPrompt(base)).not.toContain("【本轮伙伴已完成的工作】");
  });

  it("历史为空时不留下空标题", () => {
    expect(buildAgentPrompt(base)).not.toContain("【对话记录】");
  });

  it("有档案时把档案原文拼进去", () => {
    const prompt = buildAgentPrompt({ ...base, profile: "方向: AI 产品经理" });
    expect(prompt).toContain("方向: AI 产品经理");
  });
});

describe("buildTurnHistory", () => {
  const messages = [
    { groupId: "job", content: "我想找产品岗", isBot: false, sender: "我" },
    { groupId: "pixel", content: "今天好累", isBot: false, sender: "我" },
    { groupId: "job", content: "好的，先了解你的背景", isBot: true, sender: "团团" },
  ];

  it("只取本群的消息", () => {
    const h = buildTurnHistory(messages, "job");
    expect(h).toHaveLength(2);
    expect(h.every((m) => m.content !== "今天好累")).toBe(true);
  });

  it("bot 消息映射成 assistant 并保留发言人名字", () => {
    const h = buildTurnHistory(messages, "job");
    expect(h[1]).toEqual({ role: "assistant", content: "好的，先了解你的背景", name: "团团" });
  });

  it("用户消息映射成 user", () => {
    expect(buildTurnHistory(messages, "job")[0].role).toBe("user");
  });

  it("只保留最近 limit 条", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      groupId: "job", content: `第${i}条`, isBot: false, sender: "我",
    }));
    const h = buildTurnHistory(many, "job", 20);
    expect(h).toHaveLength(20);
    expect(h[0].content).toBe("第10条");
  });

  it("跳过没有正文的消息（占位消息 content 是空串）", () => {
    const withPlaceholder = [
      { groupId: "job", content: "", isBot: true, sender: "团团" },
      { groupId: "job", content: "你好", isBot: false, sender: "我" },
    ];
    expect(buildTurnHistory(withPlaceholder, "job")).toHaveLength(1);
  });
});

describe("parseNeedMore", () => {
  const VALID2 = ["job-hunter", "resume-expert", "interview-coach", "app-tracker"];

  it("解析出追加任务", () => {
    const reply = '综合完了。NEED_MORE::[{"agentId":"interview-coach","task":"准备面试"}]';
    expect(parseNeedMore(reply, VALID2)).toEqual([
      { agentId: "interview-coach", task: "准备面试", dependsOn: [] },
    ]);
  });

  it("没有标记时返回空", () => {
    expect(parseNeedMore("综合完了，下一步你可以去投递。", VALID2)).toEqual([]);
  });

  it("标记后面跟的不是合法 JSON 时返回空，不抛错", () => {
    expect(parseNeedMore("NEED_MORE::再叫一下面试教练吧", VALID2)).toEqual([]);
  });

  it("标记后面是空数组时返回空", () => {
    expect(parseNeedMore("NEED_MORE::[]", VALID2)).toEqual([]);
  });

  it("追加任务里不认识的 agentId 同样被丢掉", () => {
    expect(parseNeedMore('NEED_MORE::[{"agentId":"产品经理","task":"随便"}]', VALID2)).toEqual([]);
  });
});
