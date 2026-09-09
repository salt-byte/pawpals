import { describe, it, expect } from "vitest";
import { createPairingStore } from "./pairing.ts";
import type { JsonFs } from "./auth.ts";

function memFs(): JsonFs {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    writeFileSync: (p, d) => { files.set(p, d); },
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
}

describe("createPairingStore", () => {
  it("配对码是 8 位、不含易混字符；兑换后得到绑定 userId 的长期 token", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const { code } = store.issueCode("u1");
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    const r = store.redeem(code);
    expect(r?.userId).toBe("u1");
    expect(r?.token.startsWith("ext_")).toBe(true);
    expect(store.resolveToken(r!.token)).toBe("u1");
  });

  it("配对码一次性：第二次兑换返回 null", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const { code } = store.issueCode("u1");
    expect(store.redeem(code)).not.toBeNull();
    expect(store.redeem(code)).toBeNull();
  });

  it("5 分钟后过期", () => {
    let t = 0;
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs(), now: () => t });
    const { code, expiresAt } = store.issueCode("u1");
    expect(expiresAt).toBe(5 * 60 * 1000);
    t = 5 * 60 * 1000 + 1;
    expect(store.redeem(code)).toBeNull();
  });

  it("兑换时大小写与空格不敏感——用户是手输的", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs(), randomCode: () => "ABCD2345" });
    store.issueCode("u1");
    expect(store.redeem(" abcd 2345 ")?.userId).toBe("u1");
  });

  it("撤销后 token 失效；count 反映绑定数", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    const t1 = store.redeem(store.issueCode("u1").code)!.token;
    const t2 = store.redeem(store.issueCode("u1").code)!.token;
    store.redeem(store.issueCode("u2").code);
    expect(store.count("u1")).toBe(2);
    expect(store.revokeAll("u1")).toBe(2);
    expect(store.resolveToken(t1)).toBeNull();
    expect(store.resolveToken(t2)).toBeNull();
    expect(store.count("u2")).toBe(1);
  });

  it("token 落盘，新实例能解析——重新部署后插件不用重新配对", () => {
    // 配对码只在内存里，所以发码和兑换必须是同一个实例；落盘的是 token
    const fs = memFs();
    const first = createPairingStore({ file: "/d/ext.json", fs });
    const token = first.redeem(first.issueCode("u1").code)!.token;
    expect(createPairingStore({ file: "/d/ext.json", fs }).resolveToken(token)).toBe("u1");
  });

  it("不认识的 token / 垃圾输入返回 null", () => {
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs() });
    expect(store.resolveToken("ext_nope")).toBeNull();
    expect(store.resolveToken("")).toBeNull();
    expect(store.redeem("")).toBeNull();
  });
});
