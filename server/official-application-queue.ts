import { randomUUID } from "crypto";

export type OfficialTaskKind = "inspect" | "fill" | "submit";
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
