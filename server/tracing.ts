/**
 * 追踪开关：把关键函数包一层，输入输出送到 LangSmith。
 *
 * 为什么值得接：这个项目今天反复栽在同一类事上——**所有指标都说成功，只有结果
 * 是错的**。加一条逐步日志之后，「意向岗位大类探到 7 个选项然后放弃了」立刻变成
 * 「被闸门拦了两次，第三次过了」，结论从「循环没用」翻转成「闸门拦错了」。
 * LangSmith 把这件事做成基础设施：每次调用的输入输出、耗时、token、失败在哪一步，
 * 留痕、可回放、可对比。
 *
 * ── 为什么默认关闭 ──
 * 这个应用的 prompt 里装着用户的真实姓名、手机、邮箱和整份简历。打开追踪 = 这些
 * 每次调用都上传到第三方并留存。所以必须是**显式打开**的两件事同时成立才生效：
 * 配了 LANGSMITH_API_KEY，且 LANGSMITH_TRACING=true。光有 key 不算——别处配了 key
 * 就偷偷开始上传，是不能接受的。
 *
 * 关闭时 traced 必须完全透明：不改返回值、不吞异常。否则「开着能跑、关了不能跑」
 * 会变成一类新 bug。
 */
export function tracingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.LANGSMITH_API_KEY) && String(env.LANGSMITH_TRACING || "").toLowerCase() === "true";
}

type AnyFn = (...args: any[]) => Promise<any>;

/** 惰性加载 langsmith：没开启时连模块都不加载，省启动开销。 */
let traceableFn: ((fn: AnyFn, config: any) => AnyFn) | null | undefined;
function loadTraceable() {
  if (traceableFn !== undefined) return traceableFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    traceableFn = require("langsmith/traceable").traceable;
  } catch {
    // 装不上就当没开：追踪是观测手段，不该成为跑不起来的原因
    traceableFn = null;
  }
  return traceableFn;
}

/**
 * 包一层追踪。未开启时原样返回传进来的函数。
 *
 * @param name  在 LangSmith 里显示的名字。取得具体些——「fill_field」比「step」有用。
 * @param meta  附加元数据，用于筛选（比如 provider、表单域名）。
 */
export function traced<T extends AnyFn>(name: string, fn: T, meta?: Record<string, unknown>): T {
  if (!tracingEnabled()) return fn;
  const wrap = loadTraceable();
  if (!wrap) return fn;
  try {
    return wrap(fn, { name, metadata: meta }) as T;
  } catch {
    return fn;
  }
}
