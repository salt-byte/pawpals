/**
 * 按用户、按天的 token 额度。
 *
 * 按 token 计，不按调用次数：一次编排轮是 3 次调用，但一次可能 5 万 token、一次
 * 8 千，按次数等于没计。
 *
 * 超额判定在一轮开始时做一次，允许该轮跑完——判定在这里，"允许跑完"由调用方
 * 保证（只在 send_message 入口查，不在每次模型调用前查）。
 *
 * 天的边界用 UTC 日期。用户在各时区，选哪个都有人半夜被重置；UTC 至少可预测。
 */
export type QuotaRecord = { day: string; used: number };

export function createQuota(opts: {
  dailyLimit: number | null;
  now?: () => number;
  load: (userId: string) => QuotaRecord | null;
  save: (userId: string, rec: QuotaRecord) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const today = () => new Date(now()).toISOString().slice(0, 10);

  const current = (userId: string): QuotaRecord => {
    const rec = opts.load(userId);
    if (!rec || rec.day !== today()) return { day: today(), used: 0 };
    return rec;
  };

  return {
    record(userId: string, tokens: number): void {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const rec = current(userId);
      rec.used += Math.round(tokens);
      opts.save(userId, rec);
    },
    used(userId: string): number {
      return current(userId).used;
    },
    exceeded(userId: string): boolean {
      if (opts.dailyLimit === null) return false;
      return current(userId).used >= opts.dailyLimit;
    },
    limit(): number | null {
      return opts.dailyLimit;
    },
  };
}
