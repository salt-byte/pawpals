/**
 * 按用户的进程内状态容器。
 *
 * 改造前 officialApplicationQueue、bossLoginPending、messages 这些都是模块级或
 * startServer() 闭包里的单份变量——两个用户会直接串：A 的投递任务被 B 领走，
 * A 触发登录弹的是 B 的桌面窗口。全部收进这里，按 userId 懒加载。
 *
 * 闲置卸载：数据都在磁盘上，内存里的只是缓存。不卸载它只会单向增长。
 * 但**有连接挂着的用户不能卸**——socket 连接闭包里持有 messages 数组的引用，
 * 卸了再建就成了两份数组。由调用方通过 isActive 告诉我们谁还连着。
 */
export type UserStateStore<T> = {
  get(userId: string): T;
  touch(userId: string): void;
  has(userId: string): boolean;
  evictIdle(isActive?: (userId: string) => boolean): string[];
  size(): number;
};

export function createUserStateStore<T>(opts: {
  create: (userId: string) => T;
  idleMs: number;
  now?: () => number;
}): UserStateStore<T> {
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, { state: T; lastActiveAt: number }>();

  return {
    get(userId) {
      let entry = entries.get(userId);
      if (!entry) {
        entry = { state: opts.create(userId), lastActiveAt: now() };
        entries.set(userId, entry);
      } else {
        entry.lastActiveAt = now();
      }
      return entry.state;
    },
    touch(userId) {
      const entry = entries.get(userId);
      if (entry) entry.lastActiveAt = now();
    },
    has(userId) { return entries.has(userId); },
    evictIdle(isActive = () => false) {
      const cutoff = now() - opts.idleMs;
      const evicted: string[] = [];
      for (const [userId, entry] of entries) {
        if (entry.lastActiveAt > cutoff) continue;
        if (isActive(userId)) continue;
        entries.delete(userId);
        evicted.push(userId);
      }
      return evicted;
    },
    size() { return entries.size; },
  };
}
