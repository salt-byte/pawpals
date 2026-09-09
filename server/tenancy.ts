/**
 * 用户上下文与数据目录。
 *
 * 整个进程原本假设只有一个人在用：CAREER_DIR 是模块级常量，io.emit 广播给所有
 * 连接。改成多用户时不想把 userId 一路传 100 多个调用点，所以放进
 * AsyncLocalStorage：careerDir() / emitTo() 内部读取，调用点写法几乎不变。
 *
 * 代价是上下文隐式——所以这里有一条不可违反的规矩：
 * **拿不到 userId 一律抛错，永不回退全局目录。** 静默回退等于跨用户写入。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export const LOCAL_USER_ID = "local";

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 目录名直接来自 userId，所以这里就是路径穿越的最后一道闸。 */
export function isValidUserId(id: unknown): id is string {
  return typeof id === "string" && USER_ID_RE.test(id);
}

const als = new AsyncLocalStorage<{ userId: string }>();

let dataRoot: string | null = null;
let localCareerDir: string | undefined;

/**
 * @param dataRoot        APP_DATA_DIR
 * @param localCareerDir  单人模式下 local 用户的 career 目录（即改造前的 CAREER_DIR）。
 *                        多用户模式不传，local 用户和其他人一样住在 users/local/career。
 */
export function initTenancy(opts: { dataRoot: string; localCareerDir?: string }): void {
  dataRoot = opts.dataRoot;
  localCareerDir = opts.localCareerDir;
}

export function runWithUser<T>(userId: string, fn: () => T): T {
  return als.run({ userId }, fn);
}

export function currentUserId(): string | null {
  return als.getStore()?.userId ?? null;
}

function requireUserId(): string {
  const userId = currentUserId();
  if (!userId) throw new Error("careerDir() 在没有用户上下文时被调用");
  if (!isValidUserId(userId)) throw new Error(`非法的 userId：${JSON.stringify(userId)}`);
  if (!dataRoot) throw new Error("initTenancy() 还没调用");
  return userId;
}

/** 用户级目录：pet.json、quota.json 之类不属于 career 的文件放这里。 */
export function userDataDir(): string {
  const userId = requireUserId();
  // 单人模式的 local 用户：用户级文件仍在 dataRoot 根下，与改造前一致
  if (userId === LOCAL_USER_ID && localCareerDir) return dataRoot!;
  return path.join(dataRoot!, "users", userId);
}

export function careerDir(): string {
  const userId = requireUserId();
  if (userId === LOCAL_USER_ID && localCareerDir) return localCareerDir;
  return path.join(dataRoot!, "users", userId, "career");
}

// ── 定向推送 ──────────────────────────────────────────────────────────

type Emitter = { to(room: string): { emit(event: string, ...args: any[]): any } };
let emitter: Emitter | null = null;

export function setEmitter(io: Emitter | null): void {
  emitter = io;
}

/**
 * 替代 io.emit：只发给当前用户的房间。
 *
 * 没有上下文时**不发**并返回 false。这里不抛错——它常在 setInterval 里被调用，
 * 抛了会把进程带下去；但也绝不能退化成广播。
 */
export function emitTo(event: string, ...args: any[]): boolean {
  const userId = currentUserId();
  if (!userId || !emitter) {
    if (!userId) console.warn(`[tenancy] emitTo("${event}") 没有用户上下文，已丢弃`);
    return false;
  }
  emitter.to(userId).emit(event, ...args);
  return true;
}
