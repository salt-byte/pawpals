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

/** 服务端是任务事实来源；扩展、标签页只是可以随时消失的执行器。 */
export type OfficialTaskPhase = "queued" | "running" | "completed" | "failed";
export type OfficialTaskStatus = {
  id: string;
  kind: OfficialTaskKind;
  phase: OfficialTaskPhase;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** 页面主动上报的最近一个安全进度点；断线重派时让用户知道从哪一步继续。 */
  progress?: Record<string, unknown>;
};

export type QueueOptions = {
  now?: () => number;
  /** 派发之后多久算「这次没人接」，可以重新派。 */
  leaseMs?: number;
  /** 入队之后多久判超时出队，让后面的任务能走。 */
  maxAgeMs?: number;
};

/**
 * In-memory bridge between the chat service and one explicitly authorised
 * browser tab. A submit task cannot exist until `confirm` is called.
 *
 * 租约 + 过期：任务派出去后进入租期，租期内 next() 不会再返回它——否则同一个
 * 任务会被反复派给同一个页面。租期过了没人回报就重新可派（扩展重连、页面刷新
 * 都属于这种）。
 *
 * 超过 maxAgeMs 直接判超时出队，并留下一个明确的失败结果。真机上反复踩到：
 * 一个任务没被完成（页面卡住、content script 报错、探测超预算）就永远卡在队首，
 * next() 一直返回它，后面所有投递都动不了，只能手工清队列。悬着的任务比失败的
 * 任务更糟——失败至少 waitForOfficialTask 能拿到结果并告诉用户。
 */
export class OfficialApplicationQueue {
  private readonly tasks = new Map<string, OfficialApplicationTask>();
  private readonly results = new Map<string, TaskResult>();
  private readonly confirmations = new Map<string, Omit<OfficialApplicationTask, "id" | "kind" | "createdAt">>();
  private readonly leases = new Map<string, number>();
  private readonly statuses = new Map<string, OfficialTaskStatus>();
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAgeMs: number;

  constructor(options: QueueOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  }

  enqueue(input: Omit<OfficialApplicationTask, "id" | "createdAt">): OfficialApplicationTask {
    const task = { ...input, id: `official_${randomUUID()}`, createdAt: this.now() };
    this.tasks.set(task.id, task);
    this.statuses.set(task.id, { id: task.id, kind: task.kind, phase: "queued", attempts: 0, createdAt: task.createdAt, updatedAt: task.createdAt });
    return task;
  }

  /** 把超龄任务判超时出队，腾出队首。 */
  private expireStale(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, task] of this.tasks) {
      if (task.createdAt > cutoff) continue;
      this.tasks.delete(id);
      this.leases.delete(id);
      const result = { ok: false, error: "任务超时：浏览器扩展未在时限内回报结果" };
      this.results.set(id, result);
      const status = this.statuses.get(id);
      if (status) Object.assign(status, { phase: "failed", updatedAt: this.now(), progress: { stage: "expired", message: result.error } });
    }
  }

  next(): OfficialApplicationTask | null {
    this.expireStale();
    const now = this.now();
    for (const task of this.tasks.values()) {
      const leasedAt = this.leases.get(task.id);
      if (leasedAt !== undefined && now - leasedAt < this.leaseMs) continue;
      this.leases.set(task.id, now);
      const status = this.statuses.get(task.id);
      if (status) Object.assign(status, { phase: "running", attempts: status.attempts + 1, updatedAt: now, progress: { stage: "dispatched" } });
      return task;
    }
    return null;
  }

  /**
   * 作废所有租约，让队列里的任务立刻可以重新派发。
   *
   * 扩展重连时调用。租约的前提是「领走的人还活着」——MV3 的 service worker 被
   * 回收后，它内存里那些还没派出去的任务就没了，而租约还挂着，任务会一直悬到
   * 租期结束。一条新连接意味着上一个持有者已经没了。
   */
  releaseLeases(): void {
    this.leases.clear();
    for (const task of this.tasks.values()) {
      const status = this.statuses.get(task.id);
      // 保留最后一个页面安全点（例如 probe 已完成 3/15）；重连只是执行器换了，
      // 不是任务从头开始。phase 变回 queued 让下一条连接可重新领取。
      if (status) Object.assign(status, { phase: "queued", updatedAt: this.now() });
    }
  }

  /** 进度不会结掉任务，因而 service worker 重启后仍保留在服务端供诊断和恢复。 */
  progress(id: string, progress: Record<string, unknown>): boolean {
    if (!this.tasks.has(id)) return false;
    const status = this.statuses.get(id);
    if (!status) return false;
    status.phase = "running";
    status.updatedAt = this.now();
    status.progress = progress;
    return true;
  }

  complete(id: string, result: TaskResult): boolean {
    if (!this.tasks.has(id)) return false;
    this.tasks.delete(id);
    this.leases.delete(id);
    this.results.set(id, result);
    const status = this.statuses.get(id);
    if (status) Object.assign(status, {
      phase: result.ok ? "completed" : "failed",
      updatedAt: this.now(),
      progress: { stage: result.ok ? "completed" : "failed", message: result.error },
    });
    return true;
  }

  result(id: string): TaskResult | null {
    return this.results.get(id) ?? null;
  }

  status(id: string): OfficialTaskStatus | null {
    const status = this.statuses.get(id);
    return status ? { ...status, progress: status.progress ? { ...status.progress } : undefined } : null;
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
