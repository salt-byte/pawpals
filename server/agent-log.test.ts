import { describe, it, expect } from "vitest";
import { formatLogEntry, renderAgentLog } from "./agent-log.ts";

const entry = (agentName: string, agentId: string | null, body: string) =>
  agentId
    ? `\n## 2026-04-27 09:32 | 🌐 PawPals → ${agentName} [${agentId}]\n${body}\n`
    : `\n## 2026-04-27 09:32 | 🌐 PawPals → ${agentName}\n${body}\n`;

const log = [
  entry("简历专家", "resume-expert", "第一次改简历"),
  entry("专业老师", "professional-teacher", "做了岗位定位"),
  entry("简历专家", "resume-expert", "第二次改简历"),
  entry("投递管家", "app-tracker", "投了字节"),
].join("");

describe("formatLogEntry", () => {
  it("把 agentId 写进条目头，便于之后按 agent 过滤", () => {
    const out = formatLogEntry({
      at: "2026-04-27 09:32",
      agentName: "简历专家",
      agentId: "resume-expert",
      userMsg: "帮我改简历",
      reply: "好的，我看看",
    });
    expect(out).toContain("[resume-expert]");
    expect(out).toContain("简历专家");
  });

  it("截断过长的用户消息与回复", () => {
    const out = formatLogEntry({
      at: "2026-04-27 09:32",
      agentName: "简历专家",
      agentId: "resume-expert",
      userMsg: "长".repeat(100),
      reply: "答".repeat(200),
      userLimit: 10,
      replyLimit: 20,
    });
    expect(out).toContain("长".repeat(10) + "」");
    expect(out).not.toContain("长".repeat(11));
    expect(out).toContain("答".repeat(20));
    expect(out).not.toContain("答".repeat(21));
  });

  it("把换行压平成空格，保证一条记录只占一行", () => {
    const out = formatLogEntry({
      at: "2026-04-27 09:32",
      agentName: "简历专家",
      agentId: "resume-expert",
      userMsg: "第一行\n第二行",
      reply: "回复第一行\n\n回复第二行",
    });
    const bodyLine = out.trim().split("\n")[1];
    expect(bodyLine).toContain("第一行 第二行");
    expect(bodyLine).toContain("回复第一行 回复第二行");
  });
});

describe("renderAgentLog", () => {
  it("把自己的条目和队友的条目分成两段", () => {
    const out = renderAgentLog(log, "resume-expert", { ownEntries: 5, teamEntries: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("【你与用户的最近交流】");
    expect(out[0]).toContain("第一次改简历");
    expect(out[0]).toContain("第二次改简历");
    expect(out[0]).not.toContain("做了岗位定位");
    expect(out[1]).toContain("【队友最近动态】");
    expect(out[1]).toContain("做了岗位定位");
    expect(out[1]).toContain("投了字节");
    expect(out[1]).not.toContain("改简历");
  });

  it("ownEntries 只保留自己最近的 N 条", () => {
    const out = renderAgentLog(log, "resume-expert", { ownEntries: 1, teamEntries: 5 });
    expect(out[0]).toContain("第二次改简历");
    expect(out[0]).not.toContain("第一次改简历");
  });

  it("teamEntries 只保留队友最近的 N 条", () => {
    const out = renderAgentLog(log, "resume-expert", { ownEntries: 5, teamEntries: 1 });
    expect(out[1]).toContain("投了字节");
    expect(out[1]).not.toContain("做了岗位定位");
  });

  it("自己还没有任何条目时不输出空的自述段", () => {
    const out = renderAgentLog(log, "interview-coach", { ownEntries: 5, teamEntries: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("【队友最近动态】");
  });

  it("只有自己的条目时不输出空的队友段", () => {
    const solo = entry("简历专家", "resume-expert", "只有我");
    const out = renderAgentLog(solo, "resume-expert", { ownEntries: 5, teamEntries: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("【你与用户的最近交流】");
  });

  it("空日志返回空数组", () => {
    expect(renderAgentLog("", "resume-expert", { ownEntries: 5, teamEntries: 5 })).toEqual([]);
  });

  it("没有 agentId 标记的旧条目算作队友动态，不会被误认成自己的", () => {
    const legacy = entry("简历专家", null, "改名前写的");
    const out = renderAgentLog(legacy, "resume-expert", { ownEntries: 5, teamEntries: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("【队友最近动态】");
    expect(out[0]).toContain("改名前写的");
  });
});
