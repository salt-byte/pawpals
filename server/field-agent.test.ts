import { describe, it, expect } from "vitest";
import { runFieldAgent, buildFieldPrompt } from "./field-agent.ts";

/**
 * 单字段的「自己想办法」循环。
 *
 * 手写流程没有恢复能力：填砸了就记下、放弃、往前走。今天真机上这样丢掉的：
 *   本科学校    option_not_found —— 可页面上明写着「未搜索到学校名称的同学，请搜索
 *                                  "其他"并选择，再填写学校名称」
 *   获奖时间    value_not_applied —— 换个日期格式就成了
 *   结束时间    想填「至今」，控件转成 1901-01-01
 *   研究生成绩排名 想填「前10%」，实际选中「前5%」
 *
 * 这些恢复策略是开放式的、随页面而变的，为每一种写一个分支永远写不完。给模型
 * 「刚才做了什么、结果是什么、页面现在长什么样」，让它自己决定下一步。
 *
 * 三条边界，不因为交给模型而松动：
 *   1. 每个字段的尝试次数有上限——不能在真实雇主的表单上无限试
 *   2. 动作只能来自固定的工具集，不认识的一律拒绝执行
 *   3. 成功只以页面回读为准，模型说成了不算
 */
function tools(overrides: any = {}) {
  const calls: any[] = [];
  const state = { value: "", options: overrides.options ?? [] as string[] };
  return {
    calls, state,
    impl: {
      probe: async () => { calls.push("probe"); return { options: state.options }; },
      fill: async (value: string) => {
        calls.push(`fill:${value}`);
        const applied = overrides.applyRule ? overrides.applyRule(value, state) : value;
        state.value = applied;
        return { value: applied };
      },
      search: async (query: string) => {
        calls.push(`search:${query}`);
        const hit = overrides.searchRule ? overrides.searchRule(query, state) : "";
        if (hit) state.value = hit;
        return { value: state.value };
      },
      ...overrides.impl,
    },
  };
}

const field = (over: any = {}) => ({
  signature: "h1", context: "本科学校", type: "widget", required: true, value: "", ...over,
});

describe("runFieldAgent", () => {
  it("一次就成的，不多试", async () => {
    const t = tools({ options: ["清华大学"] });
    const out = await runFieldAgent({
      field: field({ context: "本科学校" }),
      profile: "本科：清华大学",
      tools: t.impl,
      validate: () => ({ ok: true }),
      decide: async () => ({ action: "fill", value: "清华大学" }),
      maxAttempts: 4,
    });
    expect(out.ok).toBe(true);
    expect(t.calls).toEqual(["fill:清华大学"]);
  });

  it("填砸了会带着失败原因再问模型，模型换个办法", async () => {
    // 直接填不进去，必须走搜索
    const t = tools({
      applyRule: () => "",
      searchRule: (q: string) => (q === "北京电影学院" ? "北京电影学院" : ""),
    });
    const seen: any[] = [];
    const out = await runFieldAgent({
      field: field(),
      profile: "本科：北京电影学院",
      tools: t.impl,
      validate: () => ({ ok: true }),
      decide: async (ctx: any) => {
        seen.push(ctx.lastResult);
        return ctx.attempt === 1
          ? { action: "fill", value: "北京电影学院" }
          : { action: "search", value: "北京电影学院" };
      },
      maxAttempts: 4,
    });
    expect(out.ok).toBe(true);
    // 第二次决策时，模型看得到上一次的失败
    expect(seen[1]).toMatchObject({ ok: false, actual: "" });
  });

  it("尝试次数用完就停——不能在真实雇主的表单上无限试", async () => {
    const t = tools({ applyRule: () => "" });
    const out = await runFieldAgent({
      field: field(), profile: "档案", tools: t.impl, validate: () => ({ ok: true }),
      decide: async () => ({ action: "fill", value: "x" }),
      maxAttempts: 3,
    });
    expect(out.ok).toBe(false);
    expect(t.calls.filter((c) => c.startsWith("fill")).length).toBe(3);
  });

  it("不认识的动作一律拒绝执行，不是「尽力照做」", async () => {
    const t = tools();
    const out = await runFieldAgent({
      field: field(), profile: "档案", tools: t.impl, validate: () => ({ ok: true }),
      decide: async () => ({ action: "submit_form" } as any),
      maxAttempts: 2,
    });
    expect(out.ok).toBe(false);
    expect(t.calls).toEqual([]);
    expect(out.reason).toBe("unknown_action");
  });

  it("模型说放弃就放弃，并说明理由——这也是有效答案", async () => {
    const t = tools();
    const out = await runFieldAgent({
      field: field({ context: "民族" }), profile: "档案里没有民族",
      tools: t.impl,
      validate: () => ({ ok: true }),
      decide: async () => ({ action: "give_up", reason: "档案里查无依据" }),
      maxAttempts: 4,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("档案里查无依据");
    expect(t.calls).toEqual([]);
  });

  it("成功以页面回读为准，模型说成了不算", async () => {
    // 控件把值改写了：想填「至今」，页面变成 1901-01-01
    const t = tools({ applyRule: (v: string) => (v === "至今" ? "1901-01-01" : v) });
    let attempts = 0;
    const out = await runFieldAgent({
      field: field({ context: "结束时间", type: "text" }),
      profile: "2025-03 至今", tools: t.impl, validate: () => ({ ok: true }),
      decide: async () => { attempts += 1; return { action: "fill", value: attempts === 1 ? "至今" : "2025-07-01" }; },
      maxAttempts: 3,
    });
    expect(out.ok).toBe(true);
    expect(out.value).toBe("2025-07-01");
    expect(t.calls).toEqual(["fill:至今", "fill:2025-07-01"]);
  });

  it("探测拿到的真实选项会带进下一次决策", async () => {
    const t = tools({ options: ["前5%", "前10%", "前30%"] });
    const seen: any[] = [];
    await runFieldAgent({
      field: field({ context: "研究生成绩排名" }), profile: "排名 前10%", tools: t.impl, validate: () => ({ ok: true }),
      decide: async (ctx: any) => {
        seen.push(ctx.options);
        return ctx.attempt === 1 ? { action: "probe" } : { action: "fill", value: "前10%" };
      },
      maxAttempts: 3,
    });
    expect(seen[1]).toEqual(["前5%", "前10%", "前30%"]);
  });
});

describe("buildFieldPrompt", () => {
  it("把页面写的说明一起给模型——恢复办法常常就写在上面", () => {
    const p = buildFieldPrompt({
      field: { context: "本科学校", hint: '未搜索到学校名称的同学，请搜索"其他"并选择', options: [], type: "widget" } as any,
      profile: "本科：北京电影学院", attempt: 2,
      lastResult: { ok: false, reason: "option_not_found", actual: "" },
    });
    expect(p).toContain("请搜索");
    expect(p).toContain("第 2 次");
    // 失败要翻译成「下一步该怎么改」，不是把机器码原样贴给模型——
    // 真机上「失败（unsourced）」这种码让它去换值，而问题在出处上。
    expect(p).toContain("面板打开了，但里面没找到");
  });

  it("列出可用动作，模型只能从里面选", () => {
    const p = buildFieldPrompt({
      field: { context: "性别", options: ["男", "女"], type: "widget" } as any,
      profile: "档案", attempt: 1, lastResult: null,
    });
    for (const a of ["fill", "probe", "search", "give_up"]) expect(p).toContain(a);
  });
});

/**
 * 反编造的闸必须在循环里，不能靠调用方自觉。
 *
 * 交给模型自己想办法之后，它可以直接给出任意值——原先那道「值必须能在档案原文里
 * 指出出处、有选项时必须命中其一」的校验，如果留在循环外面，就等于没有了。
 *
 * 而循环恰恰是**执行动作**的地方：闸门必须挡在执行之前。
 */
describe("闸门在循环里", () => {
  const t = () => {
    const calls: string[] = [];
    return { calls, impl: {
      probe: async () => ({ options: [] }),
      fill: async (v: string) => { calls.push(`fill:${v}`); return { value: v }; },
      search: async (v: string) => { calls.push(`search:${v}`); return { value: v }; },
    } };
  };

  it("档案里查无依据的值不许写进页面", async () => {
    const x = t();
    const out = await runFieldAgent({
      field: { signature: "h1", context: "民族", type: "text" },
      profile: "姓名: 张小明\n手机: 13800138000",
      tools: x.impl,
      validate: (value) => (value === "汉族" ? { ok: false, reason: "unsourced" } : { ok: true }),
      decide: async () => ({ action: "fill", value: "汉族" }),
      maxAttempts: 2,
    });
    expect(x.calls).toEqual([]);          // 一次都没写进页面
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("unsourced");
  });

  it("被闸门拦下时告诉模型原因，让它换个答案", async () => {
    const x = t();
    const seen: any[] = [];
    const out = await runFieldAgent({
      field: { signature: "h1", context: "学历", type: "widget", options: ["本科", "研究生"] },
      profile: "清华大学 双硕士",
      tools: x.impl,
      validate: (value) => (value === "硕士" ? { ok: false, reason: "option_not_allowed" } : { ok: true }),
      decide: async (ctx: any) => {
        seen.push(ctx.lastResult);
        return { action: "fill", value: ctx.attempt === 1 ? "硕士" : "研究生" };
      },
      maxAttempts: 3,
    });
    expect(seen[1]).toMatchObject({ ok: false, reason: "option_not_allowed" });
    expect(x.calls).toEqual(["fill:研究生"]);
    expect(out.ok).toBe(true);
  });

  it("没给 validate 时不放行——闸门不能因为忘了传就消失", async () => {
    const x = t();
    const out = await runFieldAgent({
      field: { signature: "h1", context: "民族", type: "text" },
      profile: "档案", tools: x.impl,
      decide: async () => ({ action: "fill", value: "汉族" }),
      maxAttempts: 2,
    } as any);
    expect(x.calls).toEqual([]);
    expect(out.reason).toBe("no_validator");
  });
});

/**
 * 被闸门拦下时，要说清楚错在哪。
 *
 * 真机 trace：
 *   意向岗位大类 #1 "产品类" → unsourced
 *   意向岗位大类 #2 "产品类" → unsourced
 *   意向岗位大类 #3 "产品类" → 成功
 *
 * 同一个值三次不同判决——因为模型每次给的 source 不一样，前两次引的原文档案里
 * 没有。它把 2/3 的尝试次数花在猜「什么样的出处能过关」上。
 *
 * 「失败（unsourced）」这种机器码对模型没有帮助。告诉它具体该怎么改。
 */
describe("失败原因要能指导下一步", () => {
  it("unsourced 说清楚是 source 的问题，不是值的问题", () => {
    const p = buildFieldPrompt({
      field: { context: "意向岗位大类", options: ["产品类", "研发类"], type: "widget" } as any,
      profile: "档案", attempt: 2,
      lastResult: { ok: false, reason: "unsourced", actual: "" },
    });
    expect(p).toContain("source");
    expect(p).toContain("逐字");
    // 而且要提示「值本身可能没问题」，否则模型会去换值
    expect(p).toContain("值可能没问题");
  });

  it("option_not_allowed 提示值要从可选项里挑", () => {
    const p = buildFieldPrompt({
      field: { context: "学历", options: ["本科", "研究生"], type: "widget" } as any,
      profile: "档案", attempt: 2,
      lastResult: { ok: false, reason: "option_not_allowed", actual: "" },
    });
    expect(p).toContain("可选项");
  });

  it("控件改写了值时，提示换个写法", () => {
    const p = buildFieldPrompt({
      field: { context: "结束时间", type: "text" } as any,
      profile: "档案", attempt: 2,
      lastResult: { ok: false, reason: "value_rewritten", actual: "1901-01-01" },
    });
    expect(p).toContain("1901-01-01");
    expect(p).toContain("换个写法");
  });
});

/**
 * 有可选项时，一次只能填一个。
 *
 * 真机：「意向岗位」是多选控件，模型想选两个，给了 "产品经理,产品运营"，闸门要求
 * 值必须恰好等于某一个选项，于是连拦三次——它一直用同样的写法，因为我们没告诉它
 * 规则。规则本来就该写在 prompt 里，而不是让它撞三次去猜。
 */
describe("多选控件的写法", () => {
  it("明确告诉模型一次只填一个，不要逗号拼接", () => {
    const p = buildFieldPrompt({
      field: { context: "意向岗位", options: ["全选", "产品经理", "产品运营"], type: "widget" } as any,
      profile: "档案", attempt: 1, lastResult: null,
    });
    expect(p).toContain("一次只填一个");
  });

  it("被判越界时提醒可能是拼了多个", () => {
    const p = buildFieldPrompt({
      field: { context: "意向岗位", options: ["产品经理", "产品运营"], type: "widget" } as any,
      profile: "档案", attempt: 2,
      lastResult: { ok: false, reason: "option_not_allowed", actual: "" },
    });
    expect(p).toContain("一个");
  });
});
