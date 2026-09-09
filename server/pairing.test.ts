import { describe, it, expect } from "vitest";
import { createPairingStore, resolveHandshakeUserId } from "./pairing.ts";
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

  it("配对码撞车时重新投，不覆盖已发出、还没兑换的那个", () => {
    const scripted = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"]; // 第二次故意撞车，逼它重投
    let i = 0;
    const store = createPairingStore({ file: "/d/ext.json", fs: memFs(), randomCode: () => scripted[i++] });
    const first = store.issueCode("u1");
    const second = store.issueCode("u2");
    expect(first.code).toBe("AAAAAAAA");
    expect(second.code).toBe("BBBBBBBB"); // 没有被覆盖成 AAAAAAAA
    expect(store.redeem("AAAAAAAA")?.userId).toBe("u1"); // u1 的码没被 u2 顶掉
    expect(store.redeem("BBBBBBBB")?.userId).toBe("u2");
  });

  it("token 文件是 null 或数组时当作空表，resolveToken 不抛 TypeError", () => {
    const fsNull = memFs();
    fsNull.writeFileSync("/d/ext.json", "null");
    const storeNull = createPairingStore({ file: "/d/ext.json", fs: fsNull });
    expect(() => storeNull.resolveToken("ext_x")).not.toThrow();
    expect(storeNull.resolveToken("ext_x")).toBeNull();

    const fsArr = memFs();
    fsArr.writeFileSync("/d/ext.json", "[]");
    const storeArr = createPairingStore({ file: "/d/ext.json", fs: fsArr });
    expect(() => storeArr.resolveToken("ext_x")).not.toThrow();
    expect(storeArr.resolveToken("ext_x")).toBeNull();
  });

  it("redeem 落盘失败时回滚内存态、返回 null；码依旧算消费掉了（不能重放）", () => {
    const fs = memFs();
    const failingFs: JsonFs = { ...fs, writeFileSync: () => { throw new Error("disk full"); } };
    const store = createPairingStore({ file: "/d/ext.json", fs: failingFs });
    const { code } = store.issueCode("u1");
    expect(store.redeem(code)).toBeNull();
    expect(store.redeem(code)).toBeNull(); // 码已经被吞掉，第二次不是「失败后重试成功」
  });
});

describe("resolveHandshakeUserId", () => {
  const resolveToken = (token: string) => (token === "good" ? "u1" : null);

  it("合法 token 在两种模式下都能认出真实用户", () => {
    expect(resolveHandshakeUserId({ url: "/ws/official?token=good", multiUser: false, resolveToken })).toBe("u1");
    expect(resolveHandshakeUserId({ url: "/ws/official?token=good", multiUser: true, resolveToken })).toBe("u1");
  });

  it("不认识的 token 在两种模式下都是 null——绝不回退 local", () => {
    expect(resolveHandshakeUserId({ url: "/ws/official?token=bad", multiUser: false, resolveToken })).toBeNull();
    expect(resolveHandshakeUserId({ url: "/ws/official?token=bad", multiUser: true, resolveToken })).toBeNull();
  });

  it("没带 token：单人模式给 local", () => {
    expect(resolveHandshakeUserId({ url: "/ws/official", multiUser: false, resolveToken })).toBe("local");
  });

  it("没带 token：多用户模式给 null", () => {
    expect(resolveHandshakeUserId({ url: "/ws/official", multiUser: true, resolveToken })).toBeNull();
  });

  it("`?token=` 空值等同于没带 token", () => {
    expect(resolveHandshakeUserId({ url: "/ws/official?token=", multiUser: false, resolveToken })).toBe("local");
    expect(resolveHandshakeUserId({ url: "/ws/official?token=", multiUser: true, resolveToken })).toBeNull();
  });
});
