import { describe, expect, it } from "vitest";
import { OfficialApplicationQueue } from "./official-application-queue";

describe("OfficialApplicationQueue", () => {
  const draft = { url: "https://jobs.example.com/1", company: "Example", title: "Product Manager" };

  it("delivers inspect tasks and accepts one result", () => {
    const queue = new OfficialApplicationQueue();
    const task = queue.enqueue({ ...draft, kind: "inspect" });
    expect(queue.next()).toEqual(task);
    expect(queue.complete(task.id, { ok: true, fields: [] })).toBe(true);
    expect(queue.next()).toBeNull();
    expect(queue.result(task.id)).toEqual({ ok: true, fields: [] });
  });

  it("cannot create a submit task without a confirmation token", () => {
    const queue = new OfficialApplicationQueue();
    expect(queue.confirm("missing")).toBeNull();
    const confirmationId = queue.requestConfirmation(draft);
    const task = queue.confirm(confirmationId);
    expect(task).toMatchObject({ kind: "submit", ...draft });
    expect(queue.confirm(confirmationId)).toBeNull();
  });
});
