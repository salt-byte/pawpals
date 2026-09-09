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
    if (fs.existsSync(file)) tokens = JSON.parse(fs.readFileSync(file, "utf-8"));
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
      const code = randomCode();
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
      save();
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
