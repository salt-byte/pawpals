import { describe, it, expect, vi } from "vitest";
import { traced, tracingEnabled } from "./tracing.ts";

/**
 * 追踪开关。
 *
 * 接 LangSmith 意味着**每次模型调用的输入输出都上传到第三方**，而这个应用的
 * prompt 里装着用户的真实姓名、手机、邮箱和整份简历。所以它必须是显式打开的：
 * 不设 LANGSMITH_API_KEY 就一个字节都不出本机。
 *
 * 关掉时 traced 必须是透明的——不改变返回值、不吞异常、不引入额外的 await 语义，
 * 否则「开着能跑、关了不能跑」会变成一类新 bug。
 */
describe("traced（未开启时）", () => {
  it("原样返回结果", async () => {
    const fn = traced("t", async (a: number, b: number) => a + b);
    expect(await fn(1, 2)).toBe(3);
  });

  it("异常照常抛出，不被吞掉", async () => {
    const fn = traced("t", async () => { throw new Error("炸了"); });
    await expect(fn()).rejects.toThrow("炸了");
  });

  it("参数原样传进去", async () => {
    const spy = vi.fn(async (x: any) => x);
    await traced("t", spy)({ a: 1 });
    expect(spy).toHaveBeenCalledWith({ a: 1 });
  });

  it("没有 API key 时就是关闭的——默认不上传任何东西", () => {
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ LANGSMITH_TRACING: "true" })).toBe(false);
  });

  it("光有 key 还不够，要显式打开——避免别处配了 key 就偷偷开始上传", () => {
    expect(tracingEnabled({ LANGSMITH_API_KEY: "lsv2_x" })).toBe(false);
  });

  it("两个都齐了才算开", () => {
    expect(tracingEnabled({ LANGSMITH_API_KEY: "lsv2_x", LANGSMITH_TRACING: "true" })).toBe(true);
  });
});

/**
 * 开启了就必须真的包上，装不上要出声。
 *
 * 第一版用 require("langsmith/traceable") 加载，而这是 ESM 环境，require 根本不
 * 存在——抛错、被 catch 吞掉、返回原函数。表现是「配置全对、日志正常、LangSmith
 * 里 0 个项目」。又一次「所有指标都说成功，只有结果是错的」，而且这次是我自己写的。
 *
 * 所以两条：开启时必须真的用上包装器；加载失败要**出声**，不能静默退回。
 */
describe("traced（开启时）", () => {
  const on = { LANGSMITH_API_KEY: "x", LANGSMITH_TRACING: "true" };

  it("真的用上了包装器，不是悄悄退回原函数", async () => {
    const calls: string[] = [];
    const fake = (fn: any, cfg: any) => async (...a: any[]) => { calls.push(cfg.name); return fn(...a); };
    const fn = traced("t.name", async (x: number) => x * 2, undefined, { env: on, load: async () => fake });
    expect(await fn(3)).toBe(6);
    expect(calls).toEqual(["t.name"]);
  });

  it("加载失败时退回原函数，但要出声——静默降级是这次的教训", async () => {
    const warned: string[] = [];
    const fn = traced("t", async (x: number) => x + 1, undefined, {
      env: on,
      load: async () => { throw new Error("模块没装"); },
      warn: (m: string) => warned.push(m),
    });
    expect(await fn(1)).toBe(2);
    expect(warned.join(" ")).toContain("追踪");
  });

  it("只出声一次，不刷屏", async () => {
    const warned: string[] = [];
    const fn = traced("t", async () => 1, undefined, {
      env: on, load: async () => { throw new Error("x"); }, warn: (m: string) => warned.push(m),
    });
    await fn(); await fn(); await fn();
    expect(warned).toHaveLength(1);
  });
});
