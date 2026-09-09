import { describe, it, expect } from "vitest";
import { createQuota } from "./quota.ts";

function memQuota(dailyLimit: number | null, clock: { t: number }) {
  const rows = new Map<string, { day: string; used: number }>();
  const quota = createQuota({
    dailyLimit,
    now: () => clock.t,
    load: (id) => rows.get(id) ?? null,
    save: (id, rec) => { rows.set(id, rec); },
  });
  return { quota, rows };
}

const DAY = 24 * 60 * 60 * 1000;

describe("createQuota", () => {
  it("按 token 累计，不按次数", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", 300);
    quota.record("u1", 400);
    expect(quota.used("u1")).toBe(700);
    expect(quota.exceeded("u1")).toBe(false);
    quota.record("u1", 400);
    expect(quota.exceeded("u1")).toBe(true);
  });

  it("用户之间互不影响", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", 5000);
    expect(quota.exceeded("u2")).toBe(false);
  });

  it("跨天重置", () => {
    const clock = { t: 0 };
    const { quota } = memQuota(1000, clock);
    quota.record("u1", 5000);
    expect(quota.exceeded("u1")).toBe(true);
    clock.t = DAY + 1;
    expect(quota.used("u1")).toBe(0);
    expect(quota.exceeded("u1")).toBe(false);
  });

  it("没设上限时永不超额，但仍然记账", () => {
    const { quota } = memQuota(null, { t: 0 });
    quota.record("u1", 10_000_000);
    expect(quota.exceeded("u1")).toBe(false);
    expect(quota.used("u1")).toBe(10_000_000);
  });

  it("记账落盘：save 被调用，load 回来的值接着算", () => {
    const { quota, rows } = memQuota(1000, { t: 0 });
    quota.record("u1", 10);
    expect(rows.get("u1")).toEqual({ day: "1970-01-01", used: 10 });
  });

  it("非法 token 数忽略", () => {
    const { quota } = memQuota(1000, { t: 0 });
    quota.record("u1", NaN);
    quota.record("u1", -5);
    expect(quota.used("u1")).toBe(0);
  });

  it("上限设为 0 时每个用户都立刻超额", () => {
    const { quota } = memQuota(0, { t: 0 });
    expect(quota.exceeded("u1")).toBe(true);
    expect(quota.exceeded("u2")).toBe(true);
  });

  it("上限设为负数时每个用户都立刻超额", () => {
    const { quota } = memQuota(-100, { t: 0 });
    expect(quota.exceeded("u1")).toBe(true);
  });
});
