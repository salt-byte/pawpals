import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, normalizeEmail, validatePassword, createUserStore, createSessionStore, type JsonFs } from "./auth.ts";

/** 内存文件系统：只实现 store 用到的四个方法。 */
function memFs(): JsonFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (p, d) => { files.set(p, d); },
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
}

describe("hashPassword / verifyPassword", () => {
  it("round-trip", () => {
    const { hash, salt } = hashPassword("correct horse");
    expect(verifyPassword("correct horse", hash, salt)).toBe(true);
    expect(verifyPassword("wrong", hash, salt)).toBe(false);
  });

  it("相同密码、不同 salt 必须产生不同 hash——否则撞库一撞一片", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("hash 长度不对时返回 false 不抛错", () => {
    expect(verifyPassword("x", "ab", "cd")).toBe(false);
  });
});

describe("normalizeEmail / validatePassword", () => {
  it("邮箱 trim + 小写；不像邮箱的返回 null", () => {
    expect(normalizeEmail("  Foo@Example.com ")).toBe("foo@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
  it("密码 8~128 位", () => {
    expect(validatePassword("short")).toMatch(/8/);
    expect(validatePassword("x".repeat(129))).toMatch(/128/);
    expect(validatePassword("longenough")).toBeNull();
    expect(validatePassword(null)).toMatch(/密码/);
  });
});

describe("createUserStore", () => {
  it("注册后能登录；错密码不行；id 是服务端随机生成的，不是邮箱", () => {
    const fs = memFs();
    const store = createUserStore({ file: "/d/users.json", fs, randomId: () => "id_abc" });
    const r = store.register("A@x.com", "password1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.id).toBe("id_abc");
    expect(r.user.email).toBe("a@x.com");
    expect(store.authenticate("a@x.com", "password1")?.id).toBe("id_abc");
    expect(store.authenticate("a@x.com", "nope")).toBeNull();
    expect(store.authenticate("nobody@x.com", "password1")).toBeNull();
  });

  it("邮箱已注册时拒绝（大小写不敏感）", () => {
    const store = createUserStore({ file: "/d/users.json", fs: memFs() });
    store.register("a@x.com", "password1");
    expect(store.register("A@X.COM", "password2")).toEqual({ ok: false, error: "该邮箱已注册" });
  });

  it("落盘后新实例能读回", () => {
    const fs = memFs();
    createUserStore({ file: "/d/users.json", fs }).register("a@x.com", "password1");
    const again = createUserStore({ file: "/d/users.json", fs });
    expect(again.count()).toBe(1);
    expect(again.authenticate("a@x.com", "password1")).not.toBeNull();
  });

  it("文件不存在时当空表处理，不抛错", () => {
    const fs = memFs();
    expect(createUserStore({ file: "/d/users.json", fs }).count()).toBe(0);
  });

  it("文件损坏时必须拒绝启动——会导致身份接管和数据孤儿", () => {
    const fs = memFs();
    fs.files.set("/d/users.json", "{not json");
    expect(() => createUserStore({ file: "/d/users.json", fs })).toThrow();
    // 错误消息应该说明文件名和为什么拒绝启动
    expect(() => createUserStore({ file: "/d/users.json", fs })).toThrow(/users\.json/);
  });
});

describe("createSessionStore", () => {
  it("签发、解析、作废", () => {
    const store = createSessionStore({ file: "/d/sessions.json", fs: memFs(), ttlMs: 1000 });
    const token = store.issue("u1");
    expect(token.startsWith("paw_")).toBe(true);
    expect(store.resolve(token)).toBe("u1");
    store.revoke(token);
    expect(store.resolve(token)).toBeNull();
  });

  it("过期后解析为 null，sweep 清掉", () => {
    let t = 0;
    const store = createSessionStore({ file: "/d/sessions.json", fs: memFs(), ttlMs: 100, now: () => t });
    const token = store.issue("u1");
    t = 101;
    expect(store.resolve(token)).toBeNull();
    expect(store.sweep()).toBe(1);
  });

  it("落盘：新实例能解析旧 token——重新部署不该全员登出", () => {
    const fs = memFs();
    const token = createSessionStore({ file: "/d/s.json", fs, ttlMs: 1000 }).issue("u1");
    expect(createSessionStore({ file: "/d/s.json", fs, ttlMs: 1000 }).resolve(token)).toBe("u1");
  });

  it("文件不存在时当空表处理，不抛错", () => {
    const fs = memFs();
    expect(createSessionStore({ file: "/d/sessions.json", fs, ttlMs: 1000 }).sweep()).toBe(0);
  });

  it("文件损坏时当空表处理，不抛错", () => {
    const fs = memFs();
    fs.files.set("/d/sessions.json", "{not json");
    const store = createSessionStore({ file: "/d/sessions.json", fs, ttlMs: 1000 });
    expect(store.sweep()).toBe(0);
  });
});
