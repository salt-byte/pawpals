# 求职群多 Agent 编排改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让求职群的多 agent 协作真正发生——专家之间看得见彼此的产出，首席拿着全部产出做真正的综合。

**Architecture:** 一次用户提问 = 一个 turn。先查固定流水线模板；模板不命中时，才由首席花一次模型调用出计划（谁做什么、谁依赖谁），按拓扑分批执行（同批并行、批间串行），每批产出写进共享的 TurnLog，后续批次和最终综合都能看见完整 TurnLog。所有 agent 的 prompt 由同一个函数拼装。纯逻辑放 `server/orchestration.ts` 并单测，`server.ts` 只留 IO 编排。

**Tech Stack:** TypeScript (ESM, `type: module`)、vitest（`environment: jsdom`, `globals: false`——测试文件必须显式 import）、Socket.IO、React 19。

**Spec:** `docs/superpowers/specs/2026-09-07-job-group-orchestration-design.md`

## Global Constraints

- 相对导入必须带 `.ts` 后缀（项目跑在 `tsx` 下，`server/routing.test.ts` 即 `from "./routing.ts"`）。
- vitest 的 `globals: false`：每个测试文件都要 `import { describe, it, expect } from "vitest"`。
- vitest 的 `include` 是 `['extension/**/*.test.js', 'server/**/*.test.ts']`——新测试必须放在 `server/` 下才会被跑到。本计划不改这个配置。
- 纯函数不得 import `server.ts`、`llm.ts` 或任何有副作用的模块（照 `server/routing.ts` 的先例，它零依赖）。
- 注释和用户可见文案一律中文，与现有代码一致。
- 本轮只接管一个入口：`server.ts` 中 `msg.groupId === "job"` 且非 `@all` 的那条 else 分支。其余 10 个 `runAgentChain` 调用点一律不动。
- 被绕开的旧逻辑（`needsMultiAgent` 正则、`orchestrate()`、`resolveRoute` 分支、无上下文的首席收尾、`detectMentionedAgents` 正则接力）**不删除**——其它入口仍在使用。
- 追加轮硬上限：最多一次。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `server/orchestration.ts`（新建） | 纯函数：计划解析、拓扑分批、prompt 拼装、历史提取、追加轮信号解析、**固定流水线模板与匹配**。零副作用、零依赖。 |
| `server/orchestration.test.ts`（新建） | 上述纯函数的单测。 |
| `server.ts`（修改） | 新增 `runOrchestratedTurn()`；把求职群主入口从 `runAgentChain` 切过去；`agent_done` 补上 `agentName`。 |
| `src/App.tsx`（修改） | `agentThinking` 由单值改为集合，按 agentName 增删。 |

---

### Task 1: 计划解析与拓扑分批

**Files:**
- Create: `server/orchestration.ts`
- Test: `server/orchestration.test.ts`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `type PlanTask = { agentId: string; task: string; dependsOn?: string[] }`
  - `batchByDependency(tasks: PlanTask[]): PlanTask[][] | null` —— 成环返回 `null`
  - `parsePlan(raw: string, validAgentIds: string[]): PlanTask[]` —— 任何非法输入返回 `[]`

- [ ] **Step 1: 写失败的测试**

创建 `server/orchestration.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/orchestration.test.ts`
Expected: FAIL —— `Failed to load ./orchestration.ts`（文件还不存在）

- [ ] **Step 3: 写最小实现**

创建 `server/orchestration.ts`：

```ts
/**
 * 求职群一次对话（turn）的编排纯逻辑。
 *
 * 这里只放不碰 IO、不碰模型、不碰文件系统的东西，照 routing.ts 的先例——
 * 编排的正确性必须能被直接断言，不能只能靠真跑一遍群聊来验证。
 */

/** 首席出的计划里的一项。dependsOn 用 agentId 引用同一计划内的其它项。 */
export type PlanTask = { agentId: string; task: string; dependsOn?: string[] };

/**
 * 拓扑分批。同一批可以并行跑，批与批之间必须串行——后一批要看得见前一批的产出。
 *
 * 成环时返回 null 而不是抛错：模型输出的东西不可信，调用方据此整体降级，
 * 而不是让一次群聊因为模型写了个环就崩掉。
 */
export function batchByDependency(tasks: PlanTask[]): PlanTask[][] | null {
  const remaining = new Map(tasks.map((t) => [t.agentId, t]));
  const done = new Set<string>();
  const batches: PlanTask[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((t) =>
      (t.dependsOn ?? []).every((dep) => done.has(dep))
    );
    // 一个都不 ready，说明剩下的互相等待——成环。
    if (ready.length === 0) return null;
    for (const t of ready) {
      remaining.delete(t.agentId);
      done.add(t.agentId);
    }
    batches.push(ready);
  }

  return batches;
}

/** 模型很爱把 JSON 包在 ```json 围栏里，先剥掉。 */
function stripFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/**
 * 解析首席输出的计划。
 *
 * 一切非法输入——解析不了、不是数组、agentId 不认识、task 是空的、依赖成环——
 * 统统降级为空计划（= 首席自己回答），而不是抛错。模型的结构化输出不可信，
 * 编排层必须能吃下任何东西。
 */
export function parsePlan(raw: string, validAgentIds: string[]): PlanTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(validAgentIds);
  const seen = new Set<string>();
  const tasks: PlanTask[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const agentId = (item as any).agentId;
    const task = (item as any).task;
    if (typeof agentId !== "string" || !allowed.has(agentId)) continue;
    if (typeof task !== "string" || !task.trim()) continue;
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const rawDeps = Array.isArray((item as any).dependsOn) ? (item as any).dependsOn : [];
    tasks.push({ agentId, task: task.trim(), dependsOn: rawDeps.filter((d: unknown) => typeof d === "string") });
  }

  // 依赖指向计划外的 agent 时丢掉那条依赖——它永远不会被满足，留着等于人为造环。
  for (const t of tasks) {
    t.dependsOn = (t.dependsOn ?? []).filter((dep) => seen.has(dep) && dep !== t.agentId);
  }

  return batchByDependency(tasks) === null ? [] : tasks;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/orchestration.test.ts`
Expected: PASS，14 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add server/orchestration.ts server/orchestration.test.ts
git commit -m "feat(orchestration): 计划解析与拓扑分批

模型的结构化输出不可信，所以非法 JSON、不认识的 agentId、空任务、
成环依赖一律降级成空计划（首席自己答），而不是让一次群聊崩掉。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 统一的 prompt 拼装（含 TurnLog）

这是整个改造成立与否的地方——「协作」二字唯一的落点，就是后跑的 agent 的 prompt 里真的含有先跑完的 agent 的产出。

**Files:**
- Modify: `server/orchestration.ts`
- Test: `server/orchestration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PlanTask`
- Produces:
  - `type TurnEntry = { agentId: string; agentName: string; task: string; reply: string }`
  - `buildAgentPrompt(input: { history: { role: string; content: string; name?: string }[]; profile: string; turnLog: TurnEntry[]; task: string }): string`

- [ ] **Step 1: 写失败的测试**

追加到 `server/orchestration.test.ts`（同时把顶部 import 改成
`import { parsePlan, batchByDependency, buildAgentPrompt } from "./orchestration.ts";`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/orchestration.test.ts`
Expected: FAIL —— `buildAgentPrompt is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `server/orchestration.ts`：

```ts
/** 本轮里某个 agent 干了什么、产出了什么。turn 内所有 agent 都看得见。 */
export type TurnEntry = {
  agentId: string;
  agentName: string;
  task: string;
  reply: string;
};

/**
 * 所有 agent 的 prompt 都从这里出——包括首席。
 *
 * 改造前有三份各自为政的拼法（并行专家一份、路由单专家一份、首席收尾一份），
 * 「首席接话时手里是空的」那个 bug 就是这么来的：收尾那份压根没拼专家产出。
 * 收口成一份之后，谁也不可能再拿不到该拿的上下文。
 */
export function buildAgentPrompt(input: {
  history: { role: string; content: string; name?: string }[];
  profile: string;
  turnLog: TurnEntry[];
  task: string;
}): string {
  const blocks: string[] = [];

  if (input.history.length > 0) {
    const lines = input.history.map((m) =>
      m.role === "user" ? `用户：${m.content}` : `${m.name || "助手"}：${m.content}`
    );
    blocks.push(`【对话记录】\n${lines.join("\n")}`);
  }

  if (input.profile.trim()) {
    blocks.push(`【用户档案与简历】\n${input.profile.trim()}`);
  }

  if (input.turnLog.length > 0) {
    const lines = input.turnLog.map(
      (e) => `▸ ${e.agentName}（任务：${e.task}）\n${e.reply}`
    );
    blocks.push(`【本轮伙伴已完成的工作】\n${lines.join("\n\n")}`);
  }

  blocks.push(`【你的任务】\n${input.task}`);

  return blocks.join("\n\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/orchestration.test.ts`
Expected: PASS，22 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add server/orchestration.ts server/orchestration.test.ts
git commit -m "feat(orchestration): 统一 prompt 拼装，把本轮伙伴产出拼进去

改造前有三份各自为政的拼法，首席收尾那份压根没拼专家产出——它被要求
「接住结果」，而结果根本没递给它。收口成一份，顺带让专家之间第一次
看得见彼此。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: 对话历史提取与追加轮信号

求职群入口现在传给 agent 的是 `[{ role: "user", content: msg.content }]`——只有当前这一句，连首席都没有记忆。私聊那条路径倒是好好建了 20 条历史（`server.ts:4693`），求职群没有。这个任务补上。

**Files:**
- Modify: `server/orchestration.ts`
- Test: `server/orchestration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PlanTask`、`parsePlan`
- Produces:
  - `buildTurnHistory(messages: { groupId?: string; content?: string; isBot?: boolean; sender?: string }[], groupId: string, limit?: number): { role: string; content: string; name?: string }[]`
  - `parseNeedMore(reply: string, validAgentIds: string[]): PlanTask[]`
  - `NEED_MORE_TAG: string`（值为 `"NEED_MORE::"`）

- [ ] **Step 1: 写失败的测试**

追加到 `server/orchestration.test.ts`（import 行补上 `buildTurnHistory, parseNeedMore`）：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/orchestration.test.ts`
Expected: FAIL —— `buildTurnHistory is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `server/orchestration.ts`：

```ts
/**
 * 从全量消息里取出某个群最近的对话，转成模型认得的格式。
 *
 * 求职群入口此前只传当前这一句，连首席都没有记忆；私聊路径反而是好好建了
 * 历史的。这里把求职群补齐。
 *
 * 跳过空 content：streamAgent 会先塞一条空的占位消息再流式填充，历史里
 * 混进这种空壳只会浪费 token 并干扰模型。
 */
export function buildTurnHistory(
  messages: { groupId?: string; content?: string; isBot?: boolean; sender?: string }[],
  groupId: string,
  limit = 20
): { role: string; content: string; name?: string }[] {
  return messages
    .filter((m) => m.groupId === groupId && typeof m.content === "string" && m.content.trim())
    .slice(-limit)
    .map((m) =>
      m.isBot
        ? { role: "assistant", content: m.content as string, name: m.sender || "助手" }
        : { role: "user", content: m.content as string }
    );
}

/** 首席在综合时用这个标记申请追加一轮。硬上限一次，由调用方保证。 */
export const NEED_MORE_TAG = "NEED_MORE::";

/**
 * 解析首席综合结尾的追加轮申请。
 *
 * 这是方案里给一次性计划留的纠错出口——计划出错时不至于毫无补救，
 * 但也不会滑向「每轮都判断一次」的成本。
 */
export function parseNeedMore(reply: string, validAgentIds: string[]): PlanTask[] {
  const at = reply.indexOf(NEED_MORE_TAG);
  if (at === -1) return [];
  return parsePlan(reply.slice(at + NEED_MORE_TAG.length), validAgentIds);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/orchestration.test.ts`
Expected: PASS，32 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add server/orchestration.ts server/orchestration.test.ts
git commit -m "feat(orchestration): 对话历史提取与追加轮信号解析

求职群入口此前只传当前一句话，连首席都没有记忆——私聊路径反而好好
建了 20 条历史。补齐求职群。

追加轮是给一次性计划留的纠错出口：出错时不至于毫无补救，也不滑向
每轮判断一次的成本。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 固定流水线模板与匹配

产品决策：**常见意图走写死的流水线，模板都不命中时才花钱让模型出计划。** 求职这条赛道的主要链路是固定的（拆 JD → 改简历 → 投递 → 备面），每轮都让模型重新推导一遍既费钱又不可复现。模板层是纯函数，可以直接单测；模型出计划保留为兜底，负责应付模板覆盖不到的请求。

**Files:**
- Modify: `server/orchestration.ts`
- Test: `server/orchestration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PlanTask`、`batchByDependency`
- Produces:
  - `type PipelineStage = { agentId: string; task: string; dependsOn?: string[] }`
  - `type PipelineTemplate = { id: string; match: RegExp; stages: PipelineStage[] }`
  - `JOB_PIPELINES: PipelineTemplate[]`
  - `matchPipeline(userMsg: string, templates?: PipelineTemplate[]): PlanTask[] | null` —— 命中返回已插值的计划，未命中返回 `null`

- [ ] **Step 1: 写失败的测试**

追加到 `server/orchestration.test.ts`（顶部 import 补上 `matchPipeline, JOB_PIPELINES`）：

```ts
describe("matchPipeline", () => {
  it("面试类请求命中单段流水线", () => {
    const plan = matchPipeline("帮我准备一下面试");
    expect(plan).not.toBeNull();
    expect(plan!.map((t) => t.agentId)).toEqual(["interview-coach"]);
  });

  it("投递类请求是两段，投递管家依赖简历专家", () => {
    const plan = matchPipeline("帮我投递这个岗位")!;
    expect(plan.map((t) => t.agentId)).toEqual(["resume-expert", "app-tracker"]);
    expect(plan[1].dependsOn).toEqual(["resume-expert"]);
  });

  it("「帮我投这个岗」命中投递而不是评估 —— 模板顺序决定归属", () => {
    const plan = matchPipeline("帮我投这个岗")!;
    expect(plan[0].agentId).toBe("resume-expert");
  });

  it("搜岗类请求是两段，专业老师依赖岗位猎手", () => {
    const plan = matchPipeline("帮我搜几个产品岗")!;
    expect(plan.map((t) => t.agentId)).toEqual(["job-hunter", "professional-teacher"]);
    expect(plan[1].dependsOn).toEqual(["job-hunter"]);
  });

  it("改简历类请求命中单段", () => {
    const plan = matchPipeline("帮我优化简历")!;
    expect(plan.map((t) => t.agentId)).toEqual(["resume-expert"]);
  });

  it("评估类请求是两段，简历专家依赖专业老师", () => {
    const plan = matchPipeline("这个岗我合不合适")!;
    expect(plan.map((t) => t.agentId)).toEqual(["professional-teacher", "resume-expert"]);
    expect(plan[1].dependsOn).toEqual(["professional-teacher"]);
  });

  it("没有模板命中时返回 null，交给模型出计划", () => {
    expect(matchPipeline("今天天气不错")).toBeNull();
  });

  it("把用户原话插进任务描述里", () => {
    const plan = matchPipeline("帮我准备一下面试")!;
    expect(plan[0].task).toContain("帮我准备一下面试");
    expect(plan[0].task).not.toContain("{{msg}}");
  });

  it("每一段的 dependsOn 都是数组，与 parsePlan 的输出形状一致", () => {
    const plan = matchPipeline("帮我优化简历")!;
    for (const t of plan) expect(Array.isArray(t.dependsOn)).toBe(true);
  });

  it("内置模板全部拓扑可解 —— 手写模板里不能有环", () => {
    for (const tpl of JOB_PIPELINES) {
      const plan = tpl.stages.map((s) => ({ ...s, dependsOn: s.dependsOn ?? [] }));
      expect(batchByDependency(plan), `模板 ${tpl.id} 成环`).not.toBeNull();
    }
  });

  it("接受自定义模板表，便于扩展和测试", () => {
    const custom = [{ id: "t", match: /喵/, stages: [{ agentId: "networker", task: "{{msg}}" }] }];
    expect(matchPipeline("喵喵喵", custom)!.map((t) => t.agentId)).toEqual(["networker"]);
    expect(matchPipeline("汪汪汪", custom)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/orchestration.test.ts`
Expected: FAIL —— `matchPipeline is not a function`

- [ ] **Step 3: 写最小实现**

追加到 `server/orchestration.ts`：

```ts
export type PipelineStage = { agentId: string; task: string; dependsOn?: string[] };
export type PipelineTemplate = { id: string; match: RegExp; stages: PipelineStage[] };

/**
 * 求职群的固定流水线。
 *
 * 为什么写死而不是每轮问模型：这条赛道的主要链路本来就是固定的（拆 JD →
 * 改简历 → 投递 → 备面）。每轮花一次模型调用去重新推导同一条链，既费钱，
 * 又让同一句话两次的编排可能不一样、出问题没法复现。
 *
 * 顺序即优先级，第一个命中的模板胜出。apply 必须排在 assess 前面——
 * 「帮我投这个岗」两边都匹配得上，但用户要的是投递，不是评估。
 *
 * 模板覆盖不到的请求会落到模型出计划那条兜底路径，所以这张表不需要穷举。
 */
export const JOB_PIPELINES: PipelineTemplate[] = [
  {
    id: "interview",
    match: /面试|模拟面|面经|群面|hr\s*面/i,
    stages: [{ agentId: "interview-coach", task: "用户说：{{msg}}\n\n带他做面试准备：可能被问什么、怎么答、他现在的短板在哪。" }],
  },
  {
    id: "apply",
    match: /投递|帮.*投|请.*投|申请这个岗|apply/i,
    stages: [
      { agentId: "resume-expert", task: "用户说：{{msg}}\n\n按这次要投的岗位把简历定制一版，说明改了哪里、为什么。" },
      { agentId: "app-tracker", task: "用户说：{{msg}}\n\n执行投递并记录进度，设置后续跟进。简历专家刚定制的版本见上方伙伴产出。", dependsOn: ["resume-expert"] },
    ],
  },
  {
    id: "search",
    match: /搜.*(岗|工作|职位|实习)|找.*(工作|岗|实习)|有什么(岗|职位)|推荐.*岗|招聘/,
    stages: [
      { agentId: "job-hunter", task: "用户说：{{msg}}\n\n去搜岗位，给出具体的公司、职位和链接。" },
      { agentId: "professional-teacher", task: "用户说：{{msg}}\n\n对岗位猎手刚搜到的那批岗位（见上方伙伴产出）逐个分析匹配度并排序，说清楚为什么。", dependsOn: ["job-hunter"] },
    ],
  },
  {
    id: "resume",
    match: /改简历|优化简历|简历怎么样|看.*简历|润色.*简历|cover\s*letter/i,
    stages: [{ agentId: "resume-expert", task: "用户说：{{msg}}\n\n优化简历，指出具体问题和改法。" }],
  },
  {
    id: "assess",
    match: /这个岗|这份工作|合不合适|匹配度|适合我吗|岗位要求|jd/i,
    stages: [
      { agentId: "professional-teacher", task: "用户说：{{msg}}\n\n拆解这个岗位的要求，逐条对照用户档案分析匹配度。" },
      { agentId: "resume-expert", task: "用户说：{{msg}}\n\n根据专业老师刚做的匹配度分析（见上方伙伴产出），指出简历上还缺什么、该怎么补。", dependsOn: ["professional-teacher"] },
    ],
  },
];

/**
 * 按用户这句话找固定流水线。命中返回已插值的计划，没命中返回 null
 * ——调用方据此决定是否要花一次模型调用去出计划。
 */
export function matchPipeline(
  userMsg: string,
  templates: PipelineTemplate[] = JOB_PIPELINES
): PlanTask[] | null {
  for (const tpl of templates) {
    if (!tpl.match.test(userMsg)) continue;
    return tpl.stages.map((stage) => ({
      agentId: stage.agentId,
      task: stage.task.replaceAll("{{msg}}", userMsg),
      dependsOn: stage.dependsOn ?? [],
    }));
  }
  return null;
}
```

注意：`JOB_PIPELINES` 里的正则**不要**带 `g` 标志。带 `g` 的正则 `.test()` 有粘性 `lastIndex`，同一个模板第二次匹配同一句话会返回 false——这是个很难查的间歇性 bug。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/orchestration.test.ts`
Expected: PASS，43 个用例全绿（Task 1–3 的 32 个 + 本任务 11 个）

- [ ] **Step 5: 提交**

```bash
git add server/orchestration.ts server/orchestration.test.ts
git commit -m "feat(orchestration): 固定流水线模板与匹配

求职这条赛道的主要链路本来就是固定的，每轮花一次模型调用重新推导同一条
链既费钱、又让同一句话两次的编排不可复现。常见意图走写死的模板，模型出
计划降级为兜底。

模板顺序即优先级：apply 排在 assess 前面，因为「帮我投这个岗」两边都匹配
得上，而用户要的是投递。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: 在 server.ts 里实现 runOrchestratedTurn（先不接入口）

本任务写出完整编排但**不切换入口**——这样评审可以单独否决编排逻辑而不牵连入口切换，反之亦然。本任务结束时 `runOrchestratedTurn` 是暂时无人调用的死代码，这是刻意的。

**Files:**
- Modify: `server.ts`（在 `runAgentChain` 函数定义之后追加，即约 `server.ts:3410` 之后）

**Interfaces:**
- Consumes: Task 1–4 的 `parsePlan`、`batchByDependency`、`buildAgentPrompt`、`buildTurnHistory`、`parseNeedMore`、`matchPipeline`、`NEED_MORE_TAG`、`PlanTask`、`TurnEntry`；已有的 `streamAgent`、`JOB_AGENTS`、`agentByName`、`chatCompletion`、`CAREER_DIR`、`detectExplicitAgentId`
- Produces: `runOrchestratedTurn(io, groupId, userMsg, allMessages, petName, petPersonality): Promise<void>`

- [ ] **Step 1: 加 import**

在 `server.ts` 顶部已有的 `server/routing.ts` import 旁边加：

```ts
import {
  parsePlan,
  batchByDependency,
  buildAgentPrompt,
  buildTurnHistory,
  parseNeedMore,
  matchPipeline,
  NEED_MORE_TAG,
  type PlanTask,
  type TurnEntry,
} from "./server/orchestration.ts";
```

- [ ] **Step 2: 写档案读取与出计划两个辅助函数**

现有代码在三处内联读 `profile.md` / `resume_master.md`（`server.ts:3281`、`3336`、`3360` 附近），拼法各不相同。这里收口成一个：

```ts
/** 档案 + 简历，收口成一份。此前三处内联读取，拼法各不相同。 */
function loadProfileContext(): string {
  let ctx = "";
  try {
    const profilePath = path.join(CAREER_DIR, "profile.md");
    const resumePath = path.join(CAREER_DIR, "resume_master.md");
    const profile = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
    const resume = existsSync(resumePath) ? readFileSync(resumePath, "utf8") : "";
    if (profile) ctx += `【用户档案】\n${profile}`;
    if (resume) ctx += `${ctx ? "\n\n" : ""}【简历原文】\n${resume.slice(0, 3000)}`;
  } catch {}
  return ctx;
}

/** 可被派活的专家（首席自己不进计划——它是出计划和综合的那个）。 */
function planCandidates() {
  return JOB_AGENTS.filter((a) => a.id !== "career-planner");
}

/**
 * 首席一次性出计划。**这是兜底路径**——固定流水线模板都不命中时才走到这里。
 * 返回空数组表示不需要专家、首席自己答。
 *
 * 出错、超时、模型胡说八道一律返回空数组：编排不能因为计划这一步失败就
 * 整个哑掉，降级成「首席自己回答」始终是可用的。
 */
async function requestPlan(
  userMsg: string,
  history: { role: string; content: string; name?: string }[],
  petName: string
): Promise<PlanTask[]> {
  const candidates = planCandidates();
  const roster = candidates.map((a) => `${a.id}（${a.role}）`).join("、");
  try {
    const result = await chatCompletion({
      messages: [
        {
          role: "system",
          content: `你是${petName}，求职伴学团队的协调者。根据用户这次的请求，决定要派哪些专家、各自做什么。

可派的专家：${roster}

输出规则：
- 只输出 JSON 数组，不要任何其它文字，不要 markdown 围栏。
- 每项格式：{"agentId":"专家id","task":"这个专家具体要做什么","dependsOn":["需要先完成的专家id"]}
- dependsOn 只在后一个专家确实需要前一个的产出时才写，否则留空数组（留空的会并行执行，更快）。
- 你自己（career-planner）不要出现在计划里。
- 如果这次请求你自己就能回答、不需要任何专家，输出：[]`,
        },
        {
          role: "user",
          content: buildAgentPrompt({
            history,
            profile: "",
            turnLog: [],
            task: `用户说：${userMsg}\n\n请输出计划。`,
          }),
        },
      ],
      max_tokens: 500,
    });
    return parsePlan(result.content, candidates.map((a) => a.id));
  } catch (e: any) {
    console.warn("[orchestration] 出计划失败，降级为首席自己回答：", e?.message || e);
    return [];
  }
}
```

- [ ] **Step 3: 写批次执行**

```ts
/**
 * 按拓扑批次跑计划。同批并行，批间串行——后一批的 prompt 里带着前一批的产出。
 *
 * 每个专家跑完就把产出写进 turnLog（传入的数组被就地追加），因此 turnLog 既是
 * 下一批的输入，也是最后综合的输入。
 */
async function executePlan(
  plan: PlanTask[],
  turnLog: TurnEntry[],
  io: Server,
  groupId: string,
  history: { role: string; content: string; name?: string }[],
  profile: string,
  allMessages: any[],
  petName: string,
  petPersonality: string
): Promise<void> {
  const batches = batchByDependency(plan);
  if (!batches) return; // parsePlan 已经挡过环，这里是防御

  for (const batch of batches) {
    // 快照：同一批内的专家看到的 turnLog 必须一致，否则并行结果不可复现。
    const snapshot = [...turnLog];
    const done = await Promise.all(
      batch.map(async (item) => {
        const expert = JOB_AGENTS.find((a) => a.id === item.agentId);
        if (!expert) return null;
        io.emit("agent_thinking", { agentName: expert.name, groupId });
        try {
          const { reply } = await streamAgent(
            expert,
            [{ role: "user", content: buildAgentPrompt({ history, profile, turnLog: snapshot, task: item.task }) }],
            0, io, groupId, allMessages, petName, petPersonality
          );
          return reply ? { agentId: expert.id, agentName: expert.name, task: item.task, reply } : null;
        } catch (e: any) {
          console.warn(`[orchestration] ${expert.id} 执行失败：`, e?.message || e);
          return null;
        } finally {
          io.emit("agent_done", { agentName: expert.name, groupId });
        }
      })
    );
    for (const entry of done) if (entry) turnLog.push(entry);
  }
}
```

- [ ] **Step 4: 写综合与主函数**

```ts
/**
 * 综合的职责说明。
 *
 * 改造前这里写的是「1-2 句简短收尾，绝对不要重复专家的内容」——综合这件事
 * 被 prompt 主动关掉了。现在要求的是关联、冲突、下一步：引用但不复述。
 *
 * allowMore 为 false 时不给追加出口，因为追加轮硬上限是一次。
 */
function synthesisInstruction(allowMore: boolean): string {
  const base = `以上是本轮各位专家刚刚给用户的产出，用户已经逐条看到了，不要复述内容。

你要做的是把它们接成一个整体：
1. 指出各家产出之间的关联——谁的结论支撑了谁
2. 指出彼此矛盾或对不上的地方，并给出你的判断
3. 给出明确的下一步`;

  if (!allowMore) return base;

  return `${base}

如果你判断还缺一个关键环节、必须再派一位专家才能给用户交代，就在回复最后另起一行写：
${NEED_MORE_TAG}[{"agentId":"专家id","task":"要做什么"}]
不需要就完全不要出现这个标记。

注：专家的产出里如果出现了「@某某」，那只是它的建议，不会自动触发调用——
要不要真的再派人，由你在这里决定。`;
}

/**
 * 一次用户提问的完整编排：出计划 → 分批执行 → 综合（可追加一轮）。
 *
 * 取代求职群主入口原本的三条路径（并行多专家 / 路由单专家 / 首席直接回加正则
 * 接力）。计划为空就是「首席自己答」，计划一项就是「单专家」——它们不再是独立
 * 的代码路径，因此也不会再各自拼出不一样的上下文。
 */
async function runOrchestratedTurn(
  io: Server,
  groupId: string,
  userMsg: string,
  allMessages: any[],
  petName: string,
  petPersonality: string
): Promise<void> {
  const chief = JOB_AGENTS.find((a) => a.id === "career-planner")!;
  const chiefWithName = { ...chief, name: petName };
  const history = buildTurnHistory(allMessages, groupId);
  const profile = loadProfileContext();
  const candidateIds = planCandidates().map((a) => a.id);

  // 显式 @ 时跳过出计划那次模型调用——用户已经说清楚要找谁了。
  const nameToId: Record<string, string> = {};
  for (const [name, a] of Object.entries(agentByName)) nameToId[name] = a.id;
  const explicitId = detectExplicitAgentId(userMsg, nameToId);

  let plan: PlanTask[];
  if (explicitId && explicitId !== "career-planner") {
    plan = [{ agentId: explicitId, task: userMsg, dependsOn: [] }];
  } else if (explicitId === "career-planner") {
    plan = [];
  } else {
    // 先查固定流水线：命中就省掉出计划那次模型调用，而且同一句话每次的编排都一样。
    // 模板覆盖不到的请求才落到模型出计划。
    plan = matchPipeline(userMsg) ?? await requestPlan(userMsg, history, petName);
  }

  // 没有专家要派：首席直接回答，带完整历史。
  if (plan.length === 0) {
    io.emit("agent_thinking", { agentName: petName, groupId });
    try {
      await streamAgent(
        chiefWithName,
        [{ role: "user", content: buildAgentPrompt({ history, profile, turnLog: [], task: userMsg }) }],
        0, io, groupId, allMessages, petName, petPersonality
      );
    } finally {
      io.emit("agent_done", { agentName: petName, groupId });
    }
    return;
  }

  const turnLog: TurnEntry[] = [];
  await executePlan(plan, turnLog, io, groupId, history, profile, allMessages, petName, petPersonality);

  // 一个专家都没成功产出，就别拿空的 turnLog 去让首席「综合」。
  if (turnLog.length === 0) {
    io.emit("agent_thinking", { agentName: petName, groupId });
    try {
      await streamAgent(
        chiefWithName,
        [{ role: "user", content: buildAgentPrompt({ history, profile, turnLog: [], task: userMsg }) }],
        0, io, groupId, allMessages, petName, petPersonality
      );
    } finally {
      io.emit("agent_done", { agentName: petName, groupId });
    }
    return;
  }

  // 综合。allowMore 只在第一次为 true —— 追加轮硬上限一次。
  const synthesize = async (allowMore: boolean): Promise<string> => {
    io.emit("agent_thinking", { agentName: petName, groupId });
    try {
      const { reply } = await streamAgent(
        chiefWithName,
        [{
          role: "user",
          content: buildAgentPrompt({
            history,
            profile,
            turnLog,
            task: synthesisInstruction(allowMore),
          }),
        }],
        0, io, groupId, allMessages, petName, petPersonality
      );
      return reply || "";
    } catch (e: any) {
      console.warn("[orchestration] 综合失败：", e?.message || e);
      return "";
    } finally {
      io.emit("agent_done", { agentName: petName, groupId });
    }
  };

  const firstReply = await synthesize(true);
  const followUp = parseNeedMore(firstReply, candidateIds)
    .filter((t) => !turnLog.some((e) => e.agentId === t.agentId));

  if (followUp.length > 0) {
    await executePlan(followUp, turnLog, io, groupId, history, profile, allMessages, petName, petPersonality);
    await synthesize(false);
  }
}
```

- [ ] **Step 5: 类型检查**

Run: `npm run lint`
Expected: 无新增类型错误（`runOrchestratedTurn` 暂时无人调用不会报错——TS 不对未使用的顶层函数报错）

- [ ] **Step 6: 已有测试仍全绿**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add server.ts
git commit -m "feat(orchestration): 实现 runOrchestratedTurn，暂未接入口

出计划 → 拓扑分批执行 → 综合（最多追加一轮）。计划为空即「首席自己答」、
计划一项即「单专家」，不再是独立代码路径，因此不会再各自拼出不一样的
上下文。

顺带把三处内联的档案读取收口成 loadProfileContext()。

本次刻意不切换入口，让编排逻辑和入口切换可以被分别否决。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 切换求职群主入口

**Files:**
- Modify: `server.ts:4744-4755`（`else` 分支，即 `const targetAgent = detectTargetAgent(msg.content);` 那一段）
- Modify: `server.ts` 中求职群相关的 `io.emit("agent_done", ...)`——补上 `agentName`

**Interfaces:**
- Consumes: Task 5 的 `runOrchestratedTurn`
- Produces: `agent_done` 事件的载荷从 `{ groupId }` 变为 `{ groupId, agentName? }`

- [ ] **Step 1: 换掉入口分支**

把 `server.ts:4744` 起的 `else` 分支整段：

```ts
          } else {
            const targetAgent = detectTargetAgent(msg.content);
            const resolvedAgent = targetAgent.id === "career-planner"
              ? { ...targetAgent, name: pn, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(pn)}` }
              : targetAgent;
            await runAgentChain(
              resolvedAgent,
              [{ role: "user", content: msg.content }],
              0, io, msg.groupId, messages, pn, pp
            );
            io.emit("agent_done", { groupId: msg.groupId });
          }
```

替换为：

```ts
          } else {
            // 新编排：出计划 → 分批执行 → 综合。detectTargetAgent 的显式 @ 判断
            // 已收进 runOrchestratedTurn（用 detectExplicitAgentId），不再在这里做一遍。
            await runOrchestratedTurn(io, msg.groupId, msg.content, messages, pn, pp);
          }
```

注意：`agent_done` 不在这里发了——`runOrchestratedTurn` 内部对每个 agent 各发一次，带 agentName。

- [ ] **Step 2: 给其余求职群的 agent_done 补上 agentName**

前端要按 agentName 从集合里移除，所以每个 `agent_thinking` 都必须有配对的、带同一个 agentName 的 `agent_done`。检查并修正这些行（用 `grep -n 'agent_done' server.ts` 逐个核对）：

- `server.ts:3298`、`3345`、`3386`、`3401`、`3630`、`3797`、`3822`、`3918`：把 `io.emit("agent_done", { groupId })` 改成带上对应那次 `agent_thinking` 用的同一个名字，例如 `io.emit("agent_done", { agentName: expert.name, groupId })`。
- `server.ts:4722`、`4726`、`4730`、`4734`、`4742`、`4754`：这些是 workflow 提前返回和 `@all` 的收尾。`@all`（4742）改成 `io.emit("agent_done", { agentName: agent.name, groupId: msg.groupId })`；其余几处是「整轮结束」的兜底，保持不带 agentName。

前端会把不带 agentName 的 `agent_done` 当成「全部清空」，正好覆盖这些兜底场景（见 Task 7）。

- [ ] **Step 3: 类型检查**

Run: `npm run lint`
Expected: 无新增类型错误

- [ ] **Step 4: 已有测试仍全绿**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 手动验证编排真的跑起来了**

启动：`npm run dev:isolated`

在求职群里发一句**不含双领域关键词**的话，例如「帮我看看这个岗我合不合适」。改造前这句永远只会触发单 agent（`needsMultiAgent` 正则不匹配）。

在服务端日志里确认：
- 没有出现 `[orchestration] 出计划失败`
- 群里出现了不止一个专家发言，最后由首席收尾
- 首席的收尾里**引用了**专家的结论，而不是「搞定啦」这种空话

注意模板化之后这句话是被 assess 模板直接命中的（专业老师 → 简历专家两段），**不应该**出现出计划那次模型调用。日志里如果有，说明模板没接上。

再试一句 search 模板的：「帮我搜几个产品岗」——应命中岗位猎手 → 专业老师两段，并确认**专业老师的发言里引用了岗位猎手刚搜到的那批岗位**。这是「后一段看得见前一段」的直接证据。

最后试一句谁也不命中的（例如「我最近有点迷茫，不知道该往哪个方向走」），确认它落到模型出计划那条兜底路径上，不会哑掉。

- [ ] **Step 6: 提交**

```bash
git add server.ts
git commit -m "feat(orchestration): 求职群主入口切到新编排

只接管这一个入口，@all、onboarding、四个 workflow、Boss 登录后续
继续走旧的 runAgentChain——一次性换掉 11 个调用点，出问题时无法定位。

agent_done 补上 agentName，供前端按 agent 精确移除思考指示器；不带
agentName 的仍表示「整轮结束、全部清空」。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 前端思考指示器改成集合

并行成为常态之后，单槽位的指示器会表现为「闪来闪去然后消失」——多个专家同时思考只显示最后一个，任一先完成就清空全部。

**Files:**
- Modify: `src/App.tsx:940-945`（socket 事件处理）
- Modify: `src/App.tsx` 中 `agentThinking` 的 state 声明与第 2533 行附近的渲染

**Interfaces:**
- Consumes: Task 6 的 `agent_done` 载荷 `{ groupId, agentName? }`
- Produces: 无（终点任务）

- [ ] **Step 1: 改 state 声明**

找到 `agentThinking` 的 `useState`（`grep -n "agentThinking" src/App.tsx` 定位），改为：

```tsx
  // 并行编排下会有多个 agent 同时思考，所以是集合而不是单值。
  const [thinkingAgents, setThinkingAgents] = useState<{ agentName: string; groupId: string }[]>([]);
```

- [ ] **Step 2: 改事件处理**

把 `src/App.tsx:940-945` 替换为：

```tsx
    socketRef.current.on('agent_thinking', ({ agentName, groupId }: { agentName: string; groupId: string }) => {
      setThinkingAgents(prev =>
        prev.some(a => a.agentName === agentName && a.groupId === groupId)
          ? prev
          : [...prev, { agentName, groupId }]
      );
    });
    socketRef.current.on('agent_done', ({ agentName, groupId }: { agentName?: string; groupId?: string }) => {
      // 不带 agentName 表示「整轮结束」——workflow 的兜底收尾走这条，全清。
      setThinkingAgents(prev =>
        agentName ? prev.filter(a => !(a.agentName === agentName && a.groupId === groupId)) : []
      );
    });
```

- [ ] **Step 3: 改渲染**

找到 `src/App.tsx:2533` 附近的 thinking 指示器（注释是 `{/* Agent thinking indicator — centered pill style */}`），把原本读单值的地方改为遍历当前群的集合，每个 agent 一个 pill：

```tsx
                    {/* Agent thinking indicator — 并行时会同时出现多个 */}
                    {thinkingAgents
                      .filter(a => a.groupId === activeChat?.id)
                      .map(a => (
                        <div key={a.agentName} className="flex items-center gap-2 mx-auto w-fit px-3 py-1.5 rounded-full bg-pet-cream text-xs text-pet-brown/60">
                          <span className="w-1.5 h-1.5 rounded-full bg-pet-orange animate-pulse" />
                          {a.agentName} 正在思考…
                        </div>
                      ))}
```

改法说明：先读 `src/App.tsx:2533` 附近原本那个 pill 的 JSX，**保留它自己的 className 和内部结构原样不动**，只做两件事——把外层从「渲染单个 `agentThinking`」换成「`.filter(...).map(...)` 遍历」，并给每个元素加 `key={a.agentName}`。不要顺手换样式，这轮不做视觉改动。

- [ ] **Step 4: 类型检查**

Run: `npm run lint`
Expected: 无新增类型错误。若报「`agentThinking` 未定义」，说明还有遗漏的引用点，用 `grep -n "agentThinking" src/App.tsx` 找齐改完。

- [ ] **Step 5: 手动验证**

启动 `npm run dev:isolated`，在求职群发一句会命中两段流水线的话（「帮我搜几个产品岗」→ 岗位猎手、专业老师），确认：
- 并行阶段**同时**出现多个「XX 正在思考…」
- 某个专家先说完时，只有它自己的 pill 消失，其余仍在
- 全部结束后 pill 全部消失，没有残留

- [ ] **Step 6: 提交**

```bash
git add src/App.tsx
git commit -m "fix(web): 思考指示器改成集合，并行时不再互相覆盖

单槽位的指示器在并行编排下表现为闪来闪去然后消失——多个专家同时思考
只显示最后一个，任一先完成就清空全部。

不带 agentName 的 agent_done 仍表示整轮结束、全部清空，覆盖 workflow
的兜底收尾。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 验收（对应 spec 的验收节）

全部任务完成后逐条确认：

- [ ] 「帮我看看这个岗我合不合适」这类不含双领域关键词的提问能按需触发多专家（改造前 `needsMultiAgent` 正则永不匹配）——现在由 assess 模板直接命中，零模型调用
- [ ] 模板命中时服务端日志里没有出计划那次调用；模板不命中时才有
- [ ] 后跑的专家 prompt 里含有先跑完专家的产出 —— 由 `buildAgentPrompt` 的单测保证
- [ ] 首席综合时 prompt 内含专家产出与对话历史 —— 由 `buildAgentPrompt` 的单测 + 手动观察首席收尾内容保证
- [ ] 并行时前端同时显示多个专家在思考，各自完成各自消失
- [ ] `npm test` 通过
- [ ] `npm run lint` 无新增类型错误
- [ ] 旧入口行为不变：`@all`、档案确认后的续跑、四个 workflow、Boss 登录后续各手测一次

## 出错怎么退

每个任务独立提交，回退用 `git revert <sha>`。

- Task 7 出问题：单独 revert，服务端不受影响（多发的 `agentName` 字段旧前端会忽略）。
- Task 6 出问题：单独 revert 即可退回旧的 `runAgentChain` 入口，Task 1–5 全是新增代码、不影响任何现有路径。
- Task 1–5 出问题：直接 revert，因为它们没有被任何现有路径调用。

换句话说，**Task 6 是唯一一处真正改变现有行为的提交**，其余都是纯新增。
