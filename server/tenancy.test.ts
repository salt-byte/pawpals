import { describe, it, expect, vi } from "vitest";
import {
  LOCAL_USER_ID, isValidUserId, initTenancy, runWithUser, currentUserId,
  userDataDir, careerDir, setEmitter, emitTo,
} from "./tenancy.ts";

describe("isValidUserId", () => {
  it("只接受 [A-Za-z0-9_-]{1,64}——目录名不能带路径穿越", () => {
    expect(isValidUserId("local")).toBe(true);
    expect(isValidUserId("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe(true);
    expect(isValidUserId("../etc")).toBe(false);
    expect(isValidUserId("a/b")).toBe(false);
    expect(isValidUserId("")).toBe(false);
    expect(isValidUserId("x".repeat(65))).toBe(false);
    expect(isValidUserId(null)).toBe(false);
  });
});

describe("careerDir", () => {
  it("没有用户上下文时必须抛错，永不回退全局目录", () => {
    initTenancy({ dataRoot: "/data" });
    expect(() => careerDir()).toThrow(/用户上下文/);
    expect(() => userDataDir()).toThrow(/用户上下文/);
  });

  it("上下文里返回 users/<id>/career", () => {
    initTenancy({ dataRoot: "/data" });
    runWithUser("u1", () => {
      expect(userDataDir()).toBe("/data/users/u1");
      expect(careerDir()).toBe("/data/users/u1/career");
    });
  });

  it("local 用户配了 localCareerDir 时用它——单人版数据位置一字不变", () => {
    initTenancy({ dataRoot: "/data", localCareerDir: "/data/workspace/career" });
    runWithUser(LOCAL_USER_ID, () => {
      expect(careerDir()).toBe("/data/workspace/career");
      // 用户级文件（如 pet.json）仍在 dataRoot 下，与改造前一致
      expect(userDataDir()).toBe("/data");
    });
    // 其他用户不受 localCareerDir 影响
    runWithUser("u2", () => expect(careerDir()).toBe("/data/users/u2/career"));
  });

  it("非法 userId 进了上下文也要抛错——最后一道闸", () => {
    initTenancy({ dataRoot: "/data" });
    expect(() => runWithUser("../x", () => careerDir())).toThrow();
  });

  it("上下文跨 await 传播", async () => {
    initTenancy({ dataRoot: "/data" });
    const seen = await runWithUser("u3", async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentUserId();
    });
    expect(seen).toBe("u3");
    expect(currentUserId()).toBeNull();
  });

  it("嵌套时内层覆盖外层，退出后恢复", () => {
    initTenancy({ dataRoot: "/data" });
    runWithUser("outer", () => {
      runWithUser("inner", () => expect(currentUserId()).toBe("inner"));
      expect(currentUserId()).toBe("outer");
    });
  });
});

describe("emitTo", () => {
  it("在上下文里只发给该用户的房间", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    setEmitter({ to });
    const ok = runWithUser("u1", () => emitTo("receive_message", { id: 1 }));
    expect(ok).toBe(true);
    expect(to).toHaveBeenCalledWith("u1");
    expect(emit).toHaveBeenCalledWith("receive_message", { id: 1 });
  });

  it("没有上下文时不发任何东西——宁可丢也不能广播给所有人", () => {
    const emit = vi.fn();
    setEmitter({ to: () => ({ emit }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(emitTo("receive_message", {})).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("receive_message"));
    warn.mockRestore();
  });

  it("emitter 没装上时返回 false 不抛错", () => {
    setEmitter(null);
    expect(runWithUser("u1", () => emitTo("x"))).toBe(false);
  });
});
