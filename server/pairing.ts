/**
 * 插件配对：短期配对码换长期 token。
 *
 * 分两段的理由：配对码要短、能手输，因此必须短命（5 分钟、一次性）；长期 token
 * 要够随机、存在插件里不需要人记。配对码即使被旁人看到，窗口也只有 5 分钟。
 *
 * 配对码只在内存里；token 落盘（重新部署后插件不用重新配对）。
 */
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
import type { JsonFs } from "./auth.ts";

/** 去掉 0/O/1/I：用户是看着屏幕手输的。 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function defaultRandomCode(): string {
  let s = "";
  for (let i = 0; i < 8; i += 1) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

type TokenRow = { userId: string; createdAt: number };

/**
 * 单人模式下的本地用户 id。字面量拷贝自 server/tenancy.ts 的 LOCAL_USER_ID——
 * 不 import 是有意的：tenancy.ts 挂着 AsyncLocalStorage 等模块级状态，这个模块
 * 要保持无依赖、纯函数，才能被 resolveHandshakeUserId 的测试直接 import。
 */
const LOCAL_USER_ID = "local";

/**
 * 握手时决定这条连接归谁。原来这段判断内联在 server.ts 的 upgrade 处理器里，
 * 处理器本身有副作用（socket.write / socket.destroy），测试 import 不到，日后
 * 谁把 handleUpgrade 挪到守卫前面，套件也不会红。提出来做纯函数：给定 URL、
 * 是否多用户模式、以及怎么解析 token，只返回“谁”或者“不认识”。
 *
 * 语义（照抄原实现，一个字不改）：
 * - 带 token：一律走 resolveToken，认不出就是 null——两种模式下都不回退 local；
 * - 不带 token（含 `?token=` 空值，因为空字符串本来就是 falsy）：单人模式给
 *   LOCAL_USER_ID，多用户模式给 null。
 */
export function resolveHandshakeUserId(opts: {
  url: string | undefined;
  multiUser: boolean;
  resolveToken: (token: string) => string | null;
}): string | null {
  const token = new URL(opts.url ?? "", "http://localhost").searchParams.get("token");
  if (token) return opts.resolveToken(token);
  return opts.multiUser ? null : LOCAL_USER_ID;
}

export function createPairingStore(opts: {
  file: string;
  fs: JsonFs;
  now?: () => number;
  randomCode?: () => string;
  randomToken?: () => string;
  codeTtlMs?: number;
}) {
  const { file, fs } = opts;
  const now = opts.now ?? (() => Date.now());
  const randomCode = opts.randomCode ?? defaultRandomCode;
  const randomToken = opts.randomToken ?? (() => "ext_" + randomBytes(32).toString("hex"));
  const codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000;

  const codes = new Map<string, { userId: string; expiresAt: number }>();

  let tokens: Record<string, TokenRow> = {};
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
      // `null` 和 `[]` 都能 JSON.parse 成功，但都不是我们要的 token 表；不认形状
      // 就当没有，别让 resolveToken 在 upgrade 处理器里对着非对象抛 TypeError。
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) tokens = parsed;
    }
  } catch {
    tokens = {};
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
  };

  const normalizeCode = (raw: unknown) => String(raw ?? "").replace(/\s+/g, "").toUpperCase();

  return {
    issueCode(userId: string): { code: string; expiresAt: number } {
      // 顺手清掉过期码，别让 Map 单向增长
      for (const [c, row] of codes) if (row.expiresAt <= now()) codes.delete(c);
      // 概率极低，但撞上就是把别人手里没兑换的码悄悄改绑给新用户——认错人，不是
      // 报错，所以必须重投，不能用 set() 直接覆盖。
      let code = randomCode();
      while (codes.has(code)) code = randomCode();
      const expiresAt = now() + codeTtlMs;
      codes.set(code, { userId, expiresAt });
      return { code, expiresAt };
    },
    redeem(raw: unknown): { token: string; userId: string } | null {
      const code = normalizeCode(raw);
      const row = codes.get(code);
      if (!row) return null;
      codes.delete(code); // 一次性：不管成不成都作废
      if (row.expiresAt <= now()) return null;
      const token = randomToken();
      tokens[token] = { userId: row.userId, createdAt: now() };
      try {
        save();
      } catch {
        // 码已经消费掉了——这是有意的，单次兑换是安全属性，不能因为落盘失败又
        // 变得可重放。回滚的只是内存里那半：没告诉插件的 token 不该继续有效。
        delete tokens[token];
        return null;
      }
      return { token, userId: row.userId };
    },
    resolveToken(token: unknown): string | null {
      if (typeof token !== "string" || !token) return null;
      return tokens[token]?.userId ?? null;
    },
    revokeAll(userId: string): number {
      let n = 0;
      for (const [token, row] of Object.entries(tokens)) if (row.userId === userId) { delete tokens[token]; n += 1; }
      if (n) save();
      return n;
    },
    count(userId: string): number {
      return Object.values(tokens).filter((r) => r.userId === userId).length;
    },
  };
}
