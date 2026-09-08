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

/**
 * 可注入的接缝，只为测试。
 *
 * 第一版用 require("langsmith/traceable") 加载——而这是 ESM 环境，require 根本
 * 不存在：抛错、被 catch 吞掉、返回原函数。表现是「配置全对、日志正常、LangSmith
 * 里 0 个项目」。又一次「所有指标都说成功，只有结果是错的」，而且是我自己写的。
 *
 * 所以现在用动态 import（ESM 里唯一正确的方式），并且**加载失败要出声**。
 */
type Seams = {
  env?: Record<string, string | undefined>;
  load?: () => Promise<(fn: AnyFn, config: any) => AnyFn>;
  warn?: (message: string) => void;
};

const defaultLoad = async () => (await import("langsmith/traceable")).traceable as any;

/**
 * 包一层追踪。未开启时**原样返回**传进来的函数——不改返回值、不吞异常。
 *
 * @param name  LangSmith 里显示的名字。取具体些：「apply.field」比「step」有用。
 * @param meta  附加元数据，用于筛选。
 */
export function traced<T extends AnyFn>(name: string, fn: T, meta?: Record<string, unknown>, seams: Seams = {}): T {
  const { env = process.env, load = defaultLoad, warn = (m: string) => console.warn(m) } = seams;
  if (!tracingEnabled(env)) return fn;

  let wrapped: AnyFn | null = null;
  let loading: Promise<void> | null = null;
  let warned = false;

  return (async (...args: any[]) => {
    if (!wrapped) {
      loading ??= load()
        .then((traceable) => { wrapped = traceable(fn, { name, metadata: meta }); })
        .catch((error) => {
          // 出声一次就够，别刷屏；但绝不能一声不吭——静默降级正是这次栽的地方
          wrapped = fn;
          if (!warned) {
            warned = true;
            warn(`[tracing] 追踪已开启但加载 langsmith 失败，本次运行不会留痕：${String((error as any)?.message || error)}`);
          }
        });
      await loading;
    }
    return (wrapped ?? fn)(...args);
  }) as T;
}
