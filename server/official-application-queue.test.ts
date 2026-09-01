import { describe, expect, it } from "vitest";
import { OfficialApplicationQueue, parseRequestedKind } from "./official-application-queue";

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

describe("parseRequestedKind", () => {
  it("放行不产生提交的任务类型", () => {
    for (const kind of ["inspect", "probe", "upload", "fill"]) {
      expect(parseRequestedKind(kind)).toBe(kind);
    }
  });

  it("submit 一律拒绝——提交只能由 confirm 令牌产生，不能从这个入口造出来", () => {
    expect(parseRequestedKind("submit")).toBe(null);
  });

  it("未知类型或非字符串返回 null", () => {
    expect(parseRequestedKind("delete_everything")).toBe(null);
    expect(parseRequestedKind(123)).toBe(null);
    expect(parseRequestedKind({})).toBe(null);
  });

  it("不传时默认 inspect——保持原有行为", () => {
    expect(parseRequestedKind(undefined, "inspect")).toBe("inspect");
  });
});

