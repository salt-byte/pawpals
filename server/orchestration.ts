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
    match: /投递|投这|帮.*投|请.*投|申请这个岗|apply/i,
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
