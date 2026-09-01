import { randomUUID } from "crypto";

export type OfficialTaskKind = "inspect" | "probe" | "upload" | "fill" | "submit";

/**
 * 校验外部请求的任务类型。
 *
 * submit 永远不在放行列表里：提交任务只能由 confirm 令牌产生（见 confirm()），
 * 不能从任何 HTTP 入口直接造出来。这是投递流程里最硬的那道闸，放宽这里等于
 * 把它废掉。
 */
const REQUESTABLE_KINDS: OfficialTaskKind[] = ["inspect", "probe", "upload", "fill"];

export function parseRequestedKind(raw: unknown, fallback: OfficialTaskKind = "inspect"): OfficialTaskKind | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") return null;
  return REQUESTABLE_KINDS.includes(raw as OfficialTaskKind) ? (raw as OfficialTaskKind) : null;
}
export type OfficialApplicationTask = {
  id: string;
  kind: OfficialTaskKind;
  url: string;
  company: string;
  title: string;
  payload?: Record<string, unknown>;
  createdAt: number;
};

export type TaskResult = { ok: boolean; error?: string; [key: string]: unknown };

/**
 * In-memory bridge between the chat service and one explicitly authorised
 * browser tab. A submit task cannot exist until `confirm` is called.
 */
export class OfficialApplicationQueue {
  private readonly tasks = new Map<string, OfficialApplicationTask>();
  private readonly results = new Map<string, TaskResult>();
  private readonly confirmations = new Map<string, Omit<OfficialApplicationTask, "id" | "kind" | "createdAt">>();

  enqueue(input: Omit<OfficialApplicationTask, "id" | "createdAt">): OfficialApplicationTask {
    const task = { ...input, id: `official_${randomUUID()}`, createdAt: Date.now() };
    this.tasks.set(task.id, task);
    return task;
  }

  next(): OfficialApplicationTask | null {
    return this.tasks.values().next().value ?? null;
  }

  complete(id: string, result: TaskResult): boolean {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    this.results.set(id, result);
    return true;
  }

  result(id: string): TaskResult | null {
    return this.results.get(id) ?? null;
  }

  requestConfirmation(input: Omit<OfficialApplicationTask, "id" | "kind" | "createdAt">): string {
    const confirmationId = `confirm_${randomUUID()}`;
    this.confirmations.set(confirmationId, input);
    return confirmationId;
  }

  confirm(confirmationId: string): OfficialApplicationTask | null {
    const input = this.confirmations.get(confirmationId);
    if (!input) return null;
    this.confirmations.delete(confirmationId);
    return this.enqueue({ ...input, kind: "submit" });
  }

  reject(confirmationId: string): boolean {
    return this.confirmations.delete(confirmationId);
  }
}
