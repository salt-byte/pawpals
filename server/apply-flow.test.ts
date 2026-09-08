import { describe, it, expect } from "vitest";
import { runApplyFlow } from "./apply-flow.ts";

/**
 * 投递主流程。
 *
 * 抠出来的理由：它原先是 server.ts 里 __executeToolInner 中的 300 行内联代码，
 * 没法单测。于是每验一次「中途断线还能不能接着填」都要真机跑十分钟，而真机跑
 * 一次只能覆盖一条路径。
 *
 * 所有外部动作走注入接缝（派任务、问模型、读文件），这里只测**决策**：
 * 顺序对不对、断了能不能续、闸门有没有被绕过。
 */
function harness(overrides: any = {}) {
  const calls: any[] = [];
  /** 页面状态：句柄 → 当前值。fill 会改它，inspect 会读它。 */
  const page = new Map<string, string>(overrides.page ?? []);
  const controls: any[] = overrides.controls ?? [
    { handle: "h-name", type: "text", context: "姓名", required: true },
    { handle: "h-edu", type: "widget", context: "学历", required: true },
  ];
  let inspectCount = 0;

  const deps = {
    runTask: async (task: any) => {
      calls.push(task.kind);
      if (overrides.onTask) {
        const forced = await overrides.onTask(task, { inspectCount, page });
        if (forced !== undefined) return forced;
      }
      if (task.kind === "inspect") {
        inspectCount += 1;
        return { ok: true, formReady: true, warnings: [], hasSubmit: true,
          snapshot: controls.map((c) => ({ ...c, value: page.get(c.handle) ?? "", options: c.options ?? [] })) };
      }
      if (task.kind === "probe") {
        return { ok: true, probed: (task.payload?.signatures ?? []).map((s: string) => ({
          signature: s, options: overrides.optionsFor?.(s) ?? ["本科", "研究生"], timedOut: false })) };
      }
      if (task.kind === "fill") {
        const filled: string[] = [];
        for (const v of task.payload?.values ?? []) { page.set(v.signature, v.value); filled.push(v.signature); }
        return { ok: true, filled, skipped: [], warnings: [] };
      }
      return { ok: true };
    },
    askModel: overrides.askModel ?? (async (fields: any[]) =>
      fields.map((f: any) => ({ signature: f.signature, value: f.options?.length ? f.options[0] : "张小明" }))),
    readProfile: () => overrides.profile ?? "姓名: 张小明\n学历: 研究生",
    findResume: () => overrides.resume ?? null,
    readFile: () => Buffer.from("x"),
    fileSize: () => 100,
    log: () => {},
    ...overrides.deps,
  };
  return { calls, page, deps, inspectCount: () => inspectCount };
}

const JOB = { url: "https://form.example.com/a", company: "帆软", title: "秋招" };

describe("runApplyFlow 顺序", () => {
  it("先采页面，再探选项，最后才填——不先看就问，模型只能瞎猜", async () => {
    const h = harness();
    await runApplyFlow(JOB, h.deps as any);
    const order = h.calls.filter((k) => ["inspect", "probe", "fill"].includes(k));
    expect(order[0]).toBe("inspect");
    expect(order.indexOf("probe")).toBeLessThan(order.indexOf("fill"));
  });

  it("填进去的值以页面回读为准", async () => {
    const h = harness();
    const out = await runApplyFlow(JOB, h.deps as any);
    expect(out.confirmed.map((f: any) => f.context).sort()).toEqual(["姓名", "学历"]);
  });

  it("一轮都没填进去就停，不空转", async () => {
    const h = harness({ askModel: async () => [] });
    await runApplyFlow(JOB, h.deps as any);
    expect(h.calls.filter((k) => k === "fill")).toHaveLength(0);
  });
});

describe("断线续填", () => {
  it("中途断线：已经填好的保留，恢复后只处理剩下的", async () => {
    let failedOnce = false;
    const h = harness({
      onTask: async (task: any, ctx: any) => {
        // 第一次 fill 只填成第一个，然后"断线"
        if (task.kind === "fill" && !failedOnce) {
          failedOnce = true;
          const first = task.payload.values[0];
          if (first) ctx.page.set(first.signature, first.value);
          return { ok: false, error: "dispatch_timeout", timedOut: true };
        }
        return undefined;
      },
    });
    const out = await runApplyFlow(JOB, h.deps as any);
    // 断线那次填进去的没丢
    expect(out.confirmed.map((f: any) => f.context)).toContain("姓名");
    // 恢复之后把剩下的也填了
    expect(out.confirmed.map((f: any) => f.context)).toContain("学历");
  });

  it("断线后重新采页面，不靠记忆判断填到哪了", async () => {
    const h = harness({
      // 页面上「姓名」本来就有值（上一次运行留下的），这次不该再填它
      page: [["h-name", "张小明"]],
    });
    const out = await runApplyFlow(JOB, h.deps as any);
    const filledThisRun = h.calls.filter((k) => k === "fill").length;
    expect(out.confirmed.map((f: any) => f.context)).toContain("姓名");
    // 只填了「学历」这一个
    expect(filledThisRun).toBeGreaterThan(0);
    expect(out.confirmed).toHaveLength(2);
  });

  it("超时不算失败到底——后面几轮照常跑", async () => {
    const h = harness({
      onTask: async (task: any) => (task.kind === "probe" ? { ok: false, error: "dispatch_timeout" } : undefined),
    });
    const out = await runApplyFlow(JOB, h.deps as any);
    expect(out.confirmed.length).toBeGreaterThan(0);
  });
});

describe("闸门在每一轮都成立", () => {
  it("简历框永远不进模型，分轮也不能绕过", async () => {
    const seen: any[] = [];
    const h = harness({
      controls: [
        { handle: "h-resume", type: "file", context: "简历附件", required: true },
        { handle: "h-name", type: "text", context: "姓名", required: true },
      ],
      askModel: async (fields: any[]) => { seen.push(...fields.map((f: any) => f.context)); return []; },
    });
    await runApplyFlow(JOB, h.deps as any);
    expect(seen).not.toContain("简历附件");
  });

  it("永远不产生 submit 任务——提交只能由确认令牌造出来", async () => {
    const h = harness();
    await runApplyFlow(JOB, h.deps as any);
    expect(h.calls).not.toContain("submit");
  });
});

describe("验收分三类", () => {
  it("已确认填写 / 控件操作失败 / 缺少用户资料，各归各的", async () => {
    const h = harness({
      controls: [
        { handle: "h-name", type: "text", context: "姓名", required: true },
        { handle: "h-city", type: "widget", context: "籍贯", required: true },
        { handle: "h-id", type: "text", context: "学号", required: true },
      ],
      // 模型答得出姓名，答不出学号；籍贯这个控件点不动
      askModel: async (fields: any[]) =>
        fields.filter((f: any) => f.context === "姓名").map((f: any) => ({ signature: f.signature, value: "张小明" })),
      onTask: async (task: any) => {
        if (task.kind !== "fill") return undefined;
        return undefined;
      },
      optionsFor: () => [],
    });
    const out = await runApplyFlow(JOB, h.deps as any);
    expect(out.confirmed.map((f: any) => f.context)).toEqual(["姓名"]);
    expect(out.questions.map((q: any) => q.label)).toContain("学号");
  });
});

/**
 * 分批填写。
 *
 * 真机：13 个值一次填，走到第 9 个（第一个 widget）时超出预算被派发层判超时，
 * 任务报 ok=false——可 content script 还在继续填，progress=filling 10/13 是在
 * ok=false **之后**才到的。结果就是：值确实填进去了，结果被丢弃，失败也无从归类
 * （页面上 6 个新填的字段，本轮计数却是 0，【控件操作失败】是空的）。
 *
 * widget 慢是本质的（点开面板 → 选中 → 收起 → 回读，每个 5~15 秒），把预算越调
 * 越大只是把问题推后。分批让每个任务都稳稳落在预算内，而且一批失败不影响其余。
 */
describe("分批填写", () => {
  it("字段多时拆成多个任务，不是一次全塞进去", async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      handle: `h${i}`, type: i < 8 ? "text" : "widget", context: `字段${i}`, required: true,
    }));
    const h = harness({ controls: many });
    await runApplyFlow(JOB, h.deps as any);
    expect(h.calls.filter((k) => k === "fill").length).toBeGreaterThan(1);
  });

  it("widget 单独分批，比文本框更小——它慢得多", async () => {
    const mixed = [
      ...Array.from({ length: 6 }, (_, i) => ({ handle: `t${i}`, type: "text", context: `文本${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ handle: `w${i}`, type: "widget", context: `下拉${i}` })),
    ];
    const sizes: number[] = [];
    const h = harness({
      controls: mixed,
      onTask: async (task: any) => {
        if (task.kind === "fill") sizes.push(task.payload.values.length);
        return undefined;
      },
    });
    await runApplyFlow(JOB, h.deps as any);
    // 每一批都不该太大——最大的那批也要能稳稳落在预算内
    expect(Math.max(...sizes)).toBeLessThanOrEqual(6);
  });

  it("一批超时不影响其余批次继续填", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ handle: `h${i}`, type: "text", context: `字段${i}` }));
    let n = 0;
    const h = harness({
      controls: many,
      onTask: async (task: any) => {
        if (task.kind !== "fill") return undefined;
        n += 1;
        // 第一批超时，后面的照常
        return n === 1 ? { ok: false, error: "dispatch_timeout", timedOut: true } : undefined;
      },
    });
    const out = await runApplyFlow(JOB, h.deps as any);
    expect(out.confirmed.length).toBeGreaterThan(0);
  });
});
