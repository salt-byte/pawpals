/**
 * 投递运行日志：记「声称的结果」和「页面实际状态」的差。
 *
 * 这个项目反复栽在同一类事上——所有指标都说成功，只有结果是错的：
 *
 *   filled=8       是任务自报的条数，不是页面上真有值
 *   ok=true        只说明赋值语句没抛错
 *   probed 有数字   partial 被当成「探完了」，没轮到的控件永远没有选项
 *   面板开了、选项点了、显示也变了，可页面内部的数据模型没提交
 *
 * 这类静默失败比报错危险得多：报错会停下来，静默成功会一路走到底。所以这里不
 * 记「做了什么」（那种日志已经有了），只记**两个数对不对得上**。对不上就是线索，
 * 不用等真机跑十分钟去撞。
 */
export type RunStep = { name: string; at: number; detail: Record<string, unknown> };
export type Suspicion = { name: string; claimed: number; actual: number; at: number };

/** 步骤上限。分轮 + 补探时步骤可以很多，别把内存吃掉。 */
const MAX_STEPS = 200;

export function createRunLog(runId: string) {
  const steps: RunStep[] = [];
  const suspicious: Suspicion[] = [];

  const push = (step: RunStep) => {
    steps.push(step);
    // 满了就丢最早的：出问题时最近发生的事最有用
    if (steps.length > MAX_STEPS) steps.shift();
  };

  return {
    /** 普通一步：记下来备查，不做判断。 */
    step(name: string, detail: Record<string, unknown> = {}) {
      push({ name, at: Date.now(), detail });
    },

    /**
     * 一步「声称做了 claimed 个，页面上实际是 actual 个」。
     *
     * 两个数不等就标成可疑——包括 actual 比 claimed 大的情况：那说明我们漏数了，
     * 同样是账对不上，同样值得看一眼（真机上派发超时那次就是：自报 0、实际填进
     * 去 10 个，按自报数判定「没推进」就当场停了）。
     */
    claim(name: string, { claimed, actual }: { claimed: number; actual: number }) {
      push({ name, at: Date.now(), detail: { claimed, actual } });
      if (claimed !== actual) suspicious.push({ name, claimed, actual, at: Date.now() });
    },

    snapshot() {
      return { runId, steps: [...steps], suspicious: [...suspicious] };
    },

    /** 一行摘要，直接打到控制台。 */
    summary(): string {
      if (!suspicious.length) return `[apply:${runId}] ${steps.length} 步，账目无异常`;
      const detail = suspicious.map((s) => `${s.name}(自报${s.claimed}/实际${s.actual})`).join(" ");
      return `[apply:${runId}] ${steps.length} 步，${suspicious.length} 处对不上：${detail}`;
    },
  };
}
