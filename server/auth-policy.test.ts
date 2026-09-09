import { describe, it, expect } from "vitest";
import { AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT, isAuthExempt, sessionCookie } from "./auth-policy.ts";

describe("isAuthExempt", () => {
  it("/api/auth/login 命中前缀表，豁免", () => {
    expect(isAuthExempt("/api/auth/login", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(true);
  });

  it("/api/health 命中精确表，豁免", () => {
    expect(isAuthExempt("/api/health", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(true);
  });

  it("/api/health-anything 不能被 /api/health 的前缀误伤——必须走精确匹配", () => {
    expect(isAuthExempt("/api/health-anything", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(false);
  });

  it("/api/extension/pair 命中精确表，豁免", () => {
    expect(isAuthExempt("/api/extension/pair", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(true);
  });

  it("/api/extension/pair-code 需要登录，前缀匹配会把它错误地一起放过，精确匹配不会", () => {
    expect(isAuthExempt("/api/extension/pair-code", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(false);
  });

  it("/api/pet 既不在前缀表也不在精确表，不豁免", () => {
    expect(isAuthExempt("/api/pet", AUTH_EXEMPT_PREFIX, AUTH_EXEMPT_EXACT)).toBe(false);
  });
});

describe("sessionCookie", () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS_IN_SECONDS = SEVEN_DAYS_MS / 1000;

  it("设置 HttpOnly 和 SameSite=Lax", () => {
    const cookie = sessionCookie("tok123", SEVEN_DAYS_MS, { NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("Max-Age 等于会话有效期（7 天，单位秒）", () => {
    const cookie = sessionCookie("tok123", SEVEN_DAYS_MS, { NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(cookie).toContain(`Max-Age=${SEVEN_DAYS_IN_SECONDS}`);
  });

  it("只有 NODE_ENV=production 时才带 Secure，其余环境不带——环境通过参数注入，不动 process.env", () => {
    const dev = sessionCookie("tok123", SEVEN_DAYS_MS, { NODE_ENV: "development" } as NodeJS.ProcessEnv);
    const test = sessionCookie("tok123", SEVEN_DAYS_MS, { NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const prod = sessionCookie("tok123", SEVEN_DAYS_MS, { NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(dev).not.toContain("Secure");
    expect(test).not.toContain("Secure");
    expect(prod).toContain("; Secure");
  });
});
