/**
 * 账号与会话。
 *
 * 改造前是一个全局 PIN：sha256("pawpals:" + pin)，无 salt、快哈希，会话在内存
 * Map 里，进程一重启全员登出。对一个人的 PIN 勉强够用，对 200 个真人密码不够。
 *
 * 这里：scrypt + 每用户独立随机 salt；用户表和会话表落盘。文件系统通过参数
 * 注入，测试用内存实现。不引入新依赖。
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

export type JsonFs = {
  readFileSync(p: string, enc: "utf-8"): string;
  writeFileSync(p: string, data: string): void;
  existsSync(p: string): boolean;
  mkdirSync(p: string, o: { recursive: true }): void;
};

const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): { hash: string; salt: string } {
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const expected = Buffer.from(hash, "hex");
    const actual = scryptSync(password, Buffer.from(salt, "hex"), SCRYPT_KEYLEN);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** 返回错误文案；合法返回 null。 */
export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return "请输入密码";
  if (raw.length < 8) return "密码至少 8 位";
  if (raw.length > 128) return "密码最多 128 位";
  return null;
}

function readJson<T>(fs: JsonFs, file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    // 文件损坏当空表：登录页打不开比丢一份可重建的会话表更糟
    return fallback;
  }
}

function writeJson(fs: JsonFs, file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── 用户表 ────────────────────────────────────────────────────────────

export type UserRecord = { id: string; email: string; hash: string; salt: string; createdAt: number };

export function createUserStore(opts: {
  file: string;
  fs: JsonFs;
  /** 用户目录名就是它，所以必须是服务端生成的随机串，绝不用邮箱。 */
  randomId?: () => string;
  now?: () => number;
}) {
  const { file, fs } = opts;
  const randomId = opts.randomId ?? (() => randomBytes(12).toString("hex"));
  const now = opts.now ?? (() => Date.now());
  const users: UserRecord[] = readJson<{ users: UserRecord[] }>(fs, file, { users: [] }).users ?? [];
  const save = () => writeJson(fs, file, { users });

  return {
    register(emailRaw: unknown, password: string): { ok: true; user: UserRecord } | { ok: false; error: string } {
      const email = normalizeEmail(emailRaw);
      if (!email) return { ok: false, error: "邮箱格式不对" };
      const bad = validatePassword(password);
      if (bad) return { ok: false, error: bad };
      if (users.some((u) => u.email === email)) return { ok: false, error: "该邮箱已注册" };
      const { hash, salt } = hashPassword(password);
      const user: UserRecord = { id: randomId(), email, hash, salt, createdAt: now() };
      users.push(user);
      save();
      return { ok: true, user };
    },
    authenticate(emailRaw: unknown, password: string): UserRecord | null {
      const email = normalizeEmail(emailRaw);
      if (!email || typeof password !== "string") return null;
      const user = users.find((u) => u.email === email);
      if (!user) return null;
      return verifyPassword(password, user.hash, user.salt) ? user : null;
    },
    findById(id: string): UserRecord | null {
      return users.find((u) => u.id === id) ?? null;
    },
    count() { return users.length; },
  };
}

// ── 会话表 ────────────────────────────────────────────────────────────

type SessionRow = { userId: string; createdAt: number };

export function createSessionStore(opts: {
  file: string;
  fs: JsonFs;
  ttlMs: number;
  now?: () => number;
  randomToken?: () => string;
}) {
  const { file, fs, ttlMs } = opts;
  const now = opts.now ?? (() => Date.now());
  // 前缀沿用改造前的 paw_，_getSessionToken 里的 Bearer 解析不用改
  const randomToken = opts.randomToken ?? (() => "paw_" + randomBytes(32).toString("hex"));
  const sessions = new Map<string, SessionRow>(Object.entries(readJson<Record<string, SessionRow>>(fs, file, {})));
  const save = () => writeJson(fs, file, Object.fromEntries(sessions));

  const expired = (row: SessionRow) => now() - row.createdAt > ttlMs;

  return {
    issue(userId: string): string {
      const token = randomToken();
      sessions.set(token, { userId, createdAt: now() });
      save();
      return token;
    },
    resolve(token: string): string | null {
      const row = sessions.get(token);
      if (!row) return null;
      if (expired(row)) return null;
      return row.userId;
    },
    revoke(token: string): void {
      if (sessions.delete(token)) save();
    },
    sweep(): number {
      let n = 0;
      for (const [token, row] of sessions) if (expired(row)) { sessions.delete(token); n += 1; }
      if (n) save();
      return n;
    },
  };
}
