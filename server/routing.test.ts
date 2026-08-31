import { describe, it, expect } from "vitest";
import { detectExplicitAgentId, resolveRoute } from "./routing.ts";

const nameToId: Record<string, string> = {
  "首席伴学官": "career-planner",
  "简历专家": "resume-expert",
  "投递管家": "app-tracker",
  "面试教练": "interview-coach",
};

const base = {
  nameToId,
  defaultAgentId: "career-planner",
  applicationAgentId: "app-tracker",
};

describe("detectExplicitAgentId", () => {
  it("识别 @名字", () => {
    expect(detectExplicitAgentId("@简历专家 帮我看看", nameToId)).toBe("resume-expert");
  });

  it("识别「回复 某人：」引用格式", () => {
    expect(detectExplicitAgentId("回复 面试教练：好的", nameToId)).toBe("interview-coach");
  });

  it("没有点名时返回 null", () => {
    expect(detectExplicitAgentId("我想找工作", nameToId)).toBeNull();
  });

  it("点名了不存在的角色时返回 null", () => {
    expect(detectExplicitAgentId("@产品经理 你好", nameToId)).toBeNull();
  });
});

describe("resolveRoute", () => {
  it("显式 @ 优先于投递意图关键词", () => {
    const r = resolveRoute({ ...base, text: "@简历专家 我这份简历投递的时候要注意什么" });
    expect(r.agentId).toBe("resume-expert");
    expect(r.route).toBe("explicit_at");
  });

  it("没有 @ 时，投递意图路由给投递管家", () => {
    const r = resolveRoute({ ...base, text: "帮我投递这个岗位" });
    expect(r.agentId).toBe("app-tracker");
    expect(r.route).toBe("application_delegate");
  });

  it("既没有 @ 也没有投递意图时，交给默认的团团", () => {
    const r = resolveRoute({ ...base, text: "今天有什么新岗位吗" });
    expect(r.agentId).toBe("career-planner");
    expect(r.route).toBe("default");
  });

  it("「回复 某人：」同样优先于投递意图", () => {
    const r = resolveRoute({ ...base, text: "回复 面试教练：那我投递前先模拟一次" });
    expect(r.agentId).toBe("interview-coach");
    expect(r.route).toBe("explicit_at");
  });
});
