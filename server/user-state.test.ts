import { describe, it, expect, vi } from "vitest";
import { createUserStateStore } from "./user-state.ts";

describe("createUserStateStore", () => {
  it("第一次 get 时才创建，同一用户拿到同一实例", () => {
    const create = vi.fn((id: string) => ({ id, items: [] as string[] }));
    const store = createUserStateStore({ create, idleMs: 1000 });
    expect(create).not.toHaveBeenCalled();
    const a1 = store.get("a");
    const a2 = store.get("a");
    expect(a1).toBe(a2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("a");
  });

  it("不同用户互不可见", () => {
    const store = createUserStateStore({ create: () => ({ items: [] as string[] }), idleMs: 1000 });
    store.get("a").items.push("x");
    expect(store.get("b").items).toEqual([]);
  });

  it("闲置超过 idleMs 的被卸载，下次 get 重新创建", () => {
    let t = 0;
    const create = vi.fn((id: string) => ({ id }));
    const store = createUserStateStore({ create, idleMs: 100, now: () => t });
    store.get("a");
    t = 50; store.get("b");
    t = 120;
    expect(store.evictIdle()).toEqual(["a"]);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    store.get("a");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("touch 刷新活跃时间", () => {
    let t = 0;
    const store = createUserStateStore({ create: (id) => ({ id }), idleMs: 100, now: () => t });
    store.get("a");
    t = 90; store.touch("a");
    t = 150;
    expect(store.evictIdle()).toEqual([]);
  });

  it("isActive 返回 true 的用户即使闲置也不卸载——有连接挂着时不能换掉它手里的数组", () => {
    let t = 0;
    const store = createUserStateStore({ create: (id) => ({ id }), idleMs: 100, now: () => t });
    store.get("a"); store.get("b");
    t = 500;
    expect(store.evictIdle((id) => id === "a")).toEqual(["b"]);
    expect(store.size()).toBe(1);
  });
});
