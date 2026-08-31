/**
 * 单个岗位的推进阶段。
 *
 * 阶段名此前以字面量散在 server.ts 六处，顺序只存在于人的脑子里——想判断
 * 「有没有推进到待投递」只能手写条件。这里收拢成一张有序表，顺序即数组
 * 位置。
 *
 * 注意与另外两个状态机的分工：
 *   - OnboardingState.phase  全局引导漏斗，走到 completed 就不再动
 *   - applicationStatus      投出去之后的对外状态（面试/offer/拒信）
 *   - workflowStage（本文件）单个岗位从选中到投出的执行过程
 */

export const WORKFLOW_STAGES = [
  { id: "new", label: "新入库" },
  { id: "selected", label: "已选中" },
  { id: "tailoring", label: "定制中" },
  { id: "apply_ready", label: "待投递" },
  { id: "applied", label: "已推进" },
] as const;

export type WorkflowStageId = (typeof WORKFLOW_STAGES)[number]["id"];

/** 阶段在流程中的位置；未知阶段返回 -1。 */
export function stageIndex(id: WorkflowStageId): number {
  return WORKFLOW_STAGES.findIndex((s) => s.id === id);
}

/**
 * 中文 label。未知阶段原样返回而不是抛错——历史数据里可能存着已经废弃的
 * 阶段名（比如从没被写入过、但一度存在于类型里的 tailored）。
 */
export function stageLabel(id: WorkflowStageId): string {
  if (!id) return "未记录";
  return WORKFLOW_STAGES.find((s) => s.id === id)?.label ?? id;
}

/** 下一个阶段；已经是终点或阶段未知时返回 null。 */
export function nextStage(id: WorkflowStageId): WorkflowStageId | null {
  const i = stageIndex(id);
  if (i < 0 || i >= WORKFLOW_STAGES.length - 1) return null;
  return WORKFLOW_STAGES[i + 1].id;
}

/**
 * stage 是否已推进到 target 或更靠后。
 * 任一侧未知时返回 false——宁可当作「还没到」，也不要凭猜测放行后续动作。
 */
export function isAtLeast(stage: WorkflowStageId, target: WorkflowStageId): boolean {
  const a = stageIndex(stage);
  const b = stageIndex(target);
  if (a < 0 || b < 0) return false;
  return a >= b;
}
