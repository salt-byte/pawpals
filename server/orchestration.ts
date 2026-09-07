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
