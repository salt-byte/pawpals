import { describe, it, expect, vi } from "vitest";
import { createUserStateStore } from "./user-state.ts";
import { createTaskBroadcaster } from "./official-socket.ts";

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

  /**
   * 唯一连接是插件的用户不能被卸载。
   *
   * 这条以前是坏的：扩展握手不认证，连接一律记在 "local" 桶下，而
   * evictIdle 传进来的 id 是已认证的真实用户 id，两边永远对不上，
   * officialTaskHub.size(id) > 0 这条豁免等于没写——网页一关，插件还连着的
   * 用户照样被卸，officialQueue 里待确认的任务和还没写回的执行结果一起没。
   * 配对握手把连接记到真实 userId 之后这条才真正生效，这里钉住它。
   *
   * 用的是 server.ts 里那个 isActive 的同一形状：socket.io 在线集合 ∪ 插件在线。
   */
  it("唯一连接是插件的用户不被卸载——他的 officialQueue 里可能正躺着待确认的任务", () => {
    let t = 0;
    const store = createUserStateStore({ create: (id) => ({ id }), idleMs: 100, now: () => t });
    const hub = createTaskBroadcaster();
    // u1 只有插件连着（网页已关），u2 谁都没连
    hub.add("u1", { send: () => {} });
    store.get("u1"); store.get("u2");
    t = 500;

    const socketUsers = new Set<string>(); // 没有任何网页会话在线
    const isActive = (id: string) => socketUsers.has(id) || hub.size(id) > 0;

    expect(store.evictIdle(isActive)).toEqual(["u2"]);
    expect(store.has("u1")).toBe(true);
  });
});
