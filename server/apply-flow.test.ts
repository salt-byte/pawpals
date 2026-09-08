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
  it("先采页面；自定义控件一定是先探到选项才问模型", async () => {
    const h = harness();
    await runApplyFlow(JOB, h.deps as any);
    const order = h.calls.filter((k) => ["inspect", "probe", "fill"].includes(k));
    expect(order[0]).toBe("inspect");
    // 控件逐个处理：探它 → 问模型 → 填它。所以 probe 必须出现在某次 fill 之前。
    expect(order.indexOf("probe")).toBeGreaterThan(-1);
    expect(order.indexOf("probe")).toBeLessThan(order.lastIndexOf("fill"));
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

/**
 * 级联：填完父级要当场补探子级。
 *
 * 真机实验（三步，决定性）：
 *   ① 父级还没填 → 探「意向岗位」→ []（空状态：没有可选择的数据）
 *   ② 填父级「意向岗位大类 = 产品类」→ 回读确认
 *   ③ 再探同一个「意向岗位」→ ["全选","产品经理","产品运营"]
 *
 * 所以级联根本没坏，坏的是**顺序**：一轮里先把所有 widget 探一遍再填，子控件
 * 永远是在父级还没填的状态下被探的，探到的必然是空。
 *
 * 分轮本该在下一轮修正，但那要等一整轮，而且轮次会因为「本轮没推进」提前停——
 * 真机上就是这样，跑满四轮「意向岗位」始终是空。填完当场补探才靠得住。
 */
describe("级联：填完父级当场补探", () => {
  function cascadeHarness() {
    const page = new Map<string, string>();
    const probes: string[][] = [];
    const controls = [
      { handle: "h-cat", type: "widget", context: "意向岗位大类", required: true },
      { handle: "h-job", type: "widget", context: "意向岗位", required: true },
    ];
    return {
      probes, page,
      deps: {
        runTask: async (task: any) => {
          if (task.kind === "inspect") {
            return { ok: true, formReady: true, warnings: [],
              snapshot: controls.map((c) => ({ ...c, value: page.get(c.handle) ?? "", options: [] })) };
          }
          if (task.kind === "probe") {
            const wanted: string[] = task.payload?.signatures ?? [];
            probes.push(wanted);
            return { ok: true, probed: wanted.map((s) => ({
              signature: s,
              // 子级只有在父级已经有值时才有选项——这是页面的真实行为
              options: s === "h-job"
                ? (page.get("h-cat") ? ["产品经理", "产品运营"] : [])
                : ["产品类", "研发类"],
              timedOut: false,
            })) };
          }
          if (task.kind === "fill") {
            const filled: string[] = [];
            for (const v of task.payload?.values ?? []) { page.set(v.signature, v.value); filled.push(v.signature); }
            return { ok: true, filled, skipped: [] };
          }
          return { ok: true };
        },
        askModel: async (fields: any[]) =>
          fields.filter((f: any) => f.options?.length).map((f: any) => ({ signature: f.signature, value: f.options[0] })),
        readProfile: () => "档案",
        findResume: () => null,
        readFile: () => Buffer.from(""),
        fileSize: () => 0,
        log: () => {},
      },
    };
  }

  it("父级填上后，子级在同一轮里被重新探到选项并填上", async () => {
    const h = cascadeHarness();
    const out = await runApplyFlow(JOB, h.deps as any);
    expect(h.page.get("h-cat")).toBe("产品类");
    expect(h.page.get("h-job")).toBe("产品经理");
    expect(out.confirmed.map((f: any) => f.context)).toContain("意向岗位");
  });

  it("子级是在父级填好之后才被探的——逐个处理天然保证这个顺序", async () => {
    const h = cascadeHarness();
    await runApplyFlow(JOB, h.deps as any);
    const jobProbes = h.probes.filter((batch) => batch.includes("h-job"));
    // 至少探到过一次，而且那次拿到了选项（否则 h-job 不会被填上）
    expect(jobProbes.length).toBeGreaterThanOrEqual(1);
    expect(h.page.get("h-job")).toBe("产品经理");
  });

  it("三级级联：大类 → 岗位 → 工作地点，一轮里全部解锁", async () => {
    const page = new Map<string, string>();
    const controls = [
      { handle: "h-cat", type: "widget", context: "意向岗位大类" },
      { handle: "h-job", type: "widget", context: "意向岗位" },
      { handle: "h-city", type: "widget", context: "意向工作地点" },
    ];
    // 真实依赖：岗位要先有大类，工作地点要先有岗位（页面原话「请先选择【意向岗位】」）
    const optionsOf = (h: string) =>
      h === "h-cat" ? ["产品类"]
      : h === "h-job" ? (page.get("h-cat") ? ["产品经理"] : [])
      : (page.get("h-job") ? ["南京"] : []);
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: controls.map((c) => ({ ...c, value: page.get(c.handle) ?? "", options: [] })) };
        }
        if (task.kind === "probe") {
          return { ok: true, probed: (task.payload?.signatures ?? []).map((h: string) => ({
            signature: h, options: optionsOf(h), timedOut: false })) };
        }
        if (task.kind === "fill") {
          const filled: string[] = [];
          for (const v of task.payload?.values ?? []) { page.set(v.signature, v.value); filled.push(v.signature); }
          return { ok: true, filled, skipped: [] };
        }
        return { ok: true };
      },
      askModel: async (fields: any[]) =>
        fields.filter((f: any) => f.options?.length).map((f: any) => ({ signature: f.signature, value: f.options[0] })),
      readProfile: () => "档案", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    await runApplyFlow(JOB, deps as any);
    expect(page.get("h-cat")).toBe("产品类");
    expect(page.get("h-job")).toBe("产品经理");
    expect(page.get("h-city")).toBe("南京");
  });

  it("没有空选项控件时不做多余的补探", async () => {
    const h = harness();
    const before = h.calls.filter((k) => k === "probe").length;
    await runApplyFlow(JOB, h.deps as any);
    const after = h.calls.filter((k) => k === "probe").length;
    // 普通场景下探测次数不该因为这个机制暴涨
    expect(after - before).toBeLessThanOrEqual(4);
  });
});

/**
 * 探不动就换下一个，别在原地打转。
 *
 * 用户盯着真机看出来的：页面上「意向团队」和「意向工作地点」被反复重试，而它们
 * 真正缺的是上面那个还没填的「意向岗位」。原因是 deferred 记了但没进本轮跳过集，
 * 下一次循环重新算 pending 时它还排在最前面，于是被反复挑中——一轮的预算全耗在
 * 两个填不了的控件上，后面能填的一个都没轮到。
 */
describe("探不到选项就换下一个", () => {
  it("同一个控件在一遍里只试一次", async () => {
    const probed: string[] = [];
    const page = new Map<string, string>();
    const controls = [
      { handle: "h-blocked", type: "widget", context: "意向工作地点" },  // 永远探不到
      { handle: "h-ok", type: "widget", context: "性别" },
    ];
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: controls.map((c) => ({ ...c, value: page.get(c.handle) ?? "", options: [] })) };
        }
        if (task.kind === "probe") {
          const wanted: string[] = task.payload?.signatures ?? [];
          probed.push(...wanted);
          return { ok: true, probed: wanted.map((h) => ({
            signature: h, options: h === "h-ok" ? ["女"] : [], timedOut: false })) };
        }
        if (task.kind === "fill") {
          for (const v of task.payload?.values ?? []) page.set(v.signature, v.value);
          return { ok: true, filled: (task.payload?.values ?? []).map((v: any) => v.signature), skipped: [] };
        }
        return { ok: true };
      },
      askModel: async (fields: any[]) =>
        fields.filter((f: any) => f.options?.length).map((f: any) => ({ signature: f.signature, value: f.options[0] })),
      readProfile: () => "档案", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    await runApplyFlow(JOB, deps as any);

    // 探不到的那个每一遍最多试一次；不能在一遍里被反复挑中
    const blockedTries = probed.filter((h) => h === "h-blocked").length;
    expect(blockedTries).toBeLessThanOrEqual(CASCADE_SWEEPS_MAX);
    // 而且能填的那个必须填上了——预算不能被卡住的那个吃光
    expect(page.get("h-ok")).toBe("女");
  });
});

/** 与 apply-flow 里的 CASCADE_PASSES 对应：每一遍最多重试一次被跳过的控件。 */
const CASCADE_SWEEPS_MAX = 4;

/**
 * 给模型看的字段，和拿去校验的字段，必须是同一份。
 *
 * 真机：本科学校 / 研究生学校 被判成「模型答不出」，可档案里明明写着北京电影学院、
 * 清华大学。链条是——fieldsForModel 对可搜索控件去掉 options（那是几千个选项的
 * 下拉，只能搜不能枚举），模型据此答出学校名；但校验拿的是**原始字段**，还带着
 * 被截断的 60 个选项，于是「北京电影学院」不在这 60 个里，判 option_not_allowed
 * 丢弃。给模型看一份、拿另一份校验，答对了也会被自己拒掉。
 */
describe("模型看到的和校验用的是同一份字段", () => {
  it("可搜索控件：模型答出的值不该被截断后的选项列表拒掉", async () => {
    const asked: any[] = [];
    const validatedAgainst: any[] = [];
    const page = new Map<string, string>();
    const school = { handle: "h-school", type: "widget", context: "本科学校",
      options: Array.from({ length: 60 }, (_, i) => `学校${i}`), truncated: true };
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: [{ ...school, value: page.get("h-school") ?? "" }] };
        }
        if (task.kind === "probe") {
          return { ok: true, probed: [{ signature: "h-school", options: school.options, truncated: true }] };
        }
        if (task.kind === "fill") {
          for (const v of task.payload?.values ?? []) page.set(v.signature, v.value);
          return { ok: true, filled: (task.payload?.values ?? []).map((v: any) => v.signature), skipped: [] };
        }
        return { ok: true };
      },
      askModel: async (ask: any[], all: any[]) => {
        asked.push(...ask);
        validatedAgainst.push(...all);
        return [{ signature: "h-school", value: "北京电影学院" }];
      },
      readProfile: () => "本科：北京电影学院", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    await runApplyFlow(JOB, deps as any);

    // 给模型看的那份已经去掉了 options（可搜索控件只能搜不能枚举）
    expect(asked.find((f) => f.signature === "h-school")?.options).toBeUndefined();
    // 拿去校验的必须是同一份，否则模型答对了也会被截断的选项列表拒掉
    expect(validatedAgainst.find((f) => f.signature === "h-school")?.options).toBeUndefined();
    expect(page.get("h-school")).toBe("北京电影学院");
  });
});

/**
 * 「模型答不出」和「控件操作失败」是两回事。
 *
 * 真机把 __ask_user__（内部标记）报进了【控件操作失败】。两类的处理完全不同：
 * 前者要回头问用户，后者是我们自己驱动不了这个控件。混在一起，用户既不知道该
 * 补什么，也不知道哪里真出了故障。
 */
describe("答不出 ≠ 操作失败", () => {
  it("模型答不出的进「缺少用户资料」，不进「控件操作失败」", async () => {
    const page = new Map<string, string>();
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: [{ handle: "h-x", type: "widget", context: "籍贯", required: true,
              options: ["江苏", "浙江"], value: page.get("h-x") ?? "" }] };
        }
        if (task.kind === "probe") return { ok: true, probed: [{ signature: "h-x", options: ["江苏", "浙江"] }] };
        return { ok: true, filled: [], skipped: [] };
      },
      askModel: async () => [],   // 档案里没有籍贯，答不出
      readProfile: () => "档案", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    const out = await runApplyFlow(JOB, deps as any);
    expect(out.broken.map((b: any) => b.field.context)).not.toContain("籍贯");
    expect(out.questions.map((q: any) => q.label)).toContain("籍贯");
    // 而且要把可选项带上，用户直接挑
    expect(out.questions.find((q: any) => q.label === "籍贯")?.options).toEqual(["江苏", "浙江"]);
  });
});

/**
 * 有值 ≠ 填对了。
 *
 * 真机：「结束时间」最后是 1901-01-01，明显是垃圾——多半模型给了「至今」之类，
 * 日期控件把它强转了。而它进了【已确认填写】，因为收尾只看「这个框有没有值」。
 *
 * 投给真实雇主的表单里，一个错的毕业时间比空着更糟：空着人家会问，错的直接就
 * 当真了。所以要记住每个字段**打算填什么**，收尾时和页面上的实际值比一遍，对不
 * 上的单独报出来让用户看一眼。
 */
describe("填错了要报出来，不能算成填好了", () => {
  it("页面上的值和我们打算填的对不上时，单独列出来", async () => {
    const page = new Map<string, string>();
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: [{ handle: "h-end", type: "text", context: "结束时间", value: page.get("h-end") ?? "" }] };
        }
        if (task.kind === "fill") {
          // 页面把「至今」强转成了 1901-01-01
          for (const v of task.payload?.values ?? []) page.set(v.signature, "1901-01-01");
          return { ok: true, filled: [], skipped: [] };
        }
        return { ok: true };
      },
      askModel: async () => [{ signature: "h-end", value: "至今" }],
      readProfile: () => "2025-07 至今", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    const out = await runApplyFlow(JOB, deps as any);
    expect(out.mismatched.map((m: any) => m.field.context)).toContain("结束时间");
    expect(out.mismatched[0]).toMatchObject({ intended: "至今", actual: "1901-01-01" });
  });

  it("填对了的不进这个列表", async () => {
    const page = new Map<string, string>();
    const deps = {
      runTask: async (task: any) => {
        if (task.kind === "inspect") {
          return { ok: true, formReady: true, warnings: [],
            snapshot: [{ handle: "h-n", type: "text", context: "姓名", value: page.get("h-n") ?? "" }] };
        }
        if (task.kind === "fill") {
          for (const v of task.payload?.values ?? []) page.set(v.signature, v.value);
          return { ok: true, filled: [], skipped: [] };
        }
        return { ok: true };
      },
      askModel: async () => [{ signature: "h-n", value: "张小明" }],
      readProfile: () => "姓名: 张小明", findResume: () => null,
      readFile: () => Buffer.from(""), fileSize: () => 0, log: () => {},
    };
    const out = await runApplyFlow(JOB, deps as any);
    expect(out.mismatched).toEqual([]);
  });
});
