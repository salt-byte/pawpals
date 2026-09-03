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

/**
 * 真机上反复踩到：一个任务没被完成（页面卡住、扩展没连上、content script 报错）
 * 就会永远卡在队首，next() 一直返回它，后面所有投递都动不了。今天手工清了三次
 * 队列才能继续测。
 */
describe("租约与过期：卡住的任务不能堵死队列", () => {
  const draft = { url: "https://jobs.example.com/1", company: "Example", title: "PM" };

  it("派出去的任务在租期内不重复派发，后面的任务能被取到", () => {
    let clock = 0;
    const queue = new OfficialApplicationQueue({ now: () => clock, leaseMs: 1000 });
    const first = queue.enqueue({ ...draft, kind: "inspect" });
    const second = queue.enqueue({ ...draft, kind: "inspect" });

    expect(queue.next()?.id).toBe(first.id);
    expect(queue.next()?.id).toBe(second.id); // 不再返回同一个
  });

  it("租期到了没人回报，任务重新可派——扩展重连后要能接上", () => {
    let clock = 0;
    const queue = new OfficialApplicationQueue({ now: () => clock, leaseMs: 1000 });
    const task = queue.enqueue({ ...draft, kind: "inspect" });

    expect(queue.next()?.id).toBe(task.id);
    expect(queue.next()).toBeNull();
    clock += 1500;
    expect(queue.next()?.id).toBe(task.id);
  });

  it("超过最大存活期直接判超时出队，结果是明确的失败而不是永远悬着", () => {
    let clock = 0;
    const queue = new OfficialApplicationQueue({ now: () => clock, leaseMs: 1000, maxAgeMs: 5000 });
    const stuck = queue.enqueue({ ...draft, kind: "probe" });
    queue.next();          // 派出去，但永远没人回报
    clock += 6000;         // 超过 maxAgeMs
    const later = queue.enqueue({ ...draft, kind: "inspect" });

    expect(queue.next()?.id).toBe(later.id); // 卡住的那个不再挡路
    expect(queue.result(stuck.id)).toMatchObject({ ok: false });
    expect(String(queue.result(stuck.id)?.error)).toContain("超时");
  });

  it("过期任务被清掉后 complete 返回 false，迟到的结果不会复活它", () => {
    let clock = 0;
    const queue = new OfficialApplicationQueue({ now: () => clock, maxAgeMs: 1000 });
    const task = queue.enqueue({ ...draft, kind: "inspect" });
    clock += 2000;
    queue.next();

    expect(queue.complete(task.id, { ok: true })).toBe(false);
    expect(queue.result(task.id)).toMatchObject({ ok: false });
  });

  it("正常完成的任务不受租约影响", () => {
    let clock = 0;
    const queue = new OfficialApplicationQueue({ now: () => clock });
    const task = queue.enqueue({ ...draft, kind: "inspect" });
    expect(queue.next()?.id).toBe(task.id);
    expect(queue.complete(task.id, { ok: true })).toBe(true);
    expect(queue.next()).toBeNull();
  });

  it("不传配置时沿用默认值，行为跟以前一样", () => {
    const queue = new OfficialApplicationQueue();
    const task = queue.enqueue({ ...draft, kind: "inspect" });
    expect(queue.next()?.id).toBe(task.id);
    expect(queue.complete(task.id, { ok: true })).toBe(true);
  });
});

