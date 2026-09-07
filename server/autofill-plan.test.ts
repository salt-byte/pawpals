import { describe, it, expect } from "vitest";
import {
  GATED_KINDS,
  fillableFields,
  buildAutofillPrompt,
  validateAutofillPlan,
} from "./autofill-plan.ts";

const profileText = `
姓名：邓雨蝶
邮箱：yudieden@usc.edu
手机：13800138000
学历：南加州大学 传播数据科学 硕士
毕业时间：2026 年 5 月
`.trim();

const fields = [
  { signature: "name=|id=n1|type=text|label=姓名", label: "姓名", kind: "first_name", type: "text", required: true, options: [] },
  { signature: "name=|id=e1|type=email|label=邮箱", label: "邮箱", kind: "email", type: "email", required: true, options: [] },
  { signature: "name=|id=d1|type=select|label=学历", label: "学历", kind: "custom", type: "select", required: true, options: ["本科", "硕士", "博士"] },
  { signature: "name=|id=r1|type=file|label=简历", label: "简历", kind: "resume", type: "file", required: true, options: [] },
  { signature: "name=|id=g1|type=radio|label=性别", label: "性别", kind: "sensitive_demographic", type: "radio", required: false, options: ["男", "女"] },
  { signature: "name=|id=c1|type=text|label=验证码", label: "验证码", kind: "verification", type: "text", required: true, options: [] },
];

const plan = (items: unknown[]) => validateAutofillPlan(items, fields, profileText);

describe("安全闸", () => {
  it("三类字段永不交给模型：简历附件、验证码、性别种族", () => {
    expect([...GATED_KINDS].sort()).toEqual(["resume", "sensitive_demographic", "verification"]);
  });

  it("fillableFields 把安全闸字段滤掉，custom 留下——那正是模型要接管的桶", () => {
    expect(fillableFields(fields).map((f) => f.label)).toEqual(["姓名", "邮箱", "学历"]);
  });

  it("prompt 里不出现安全闸字段，避免诱导模型去填它们", () => {
    const prompt = buildAutofillPrompt({ fields, profileText, ctx: { company: "58同城", title: "产品经理" } });
    expect(prompt).toContain("学历");
    expect(prompt).not.toContain("验证码");
    expect(prompt).not.toContain("性别");
  });

  it("没有签名的字段不进 prompt——无法寻址的框给了模型也填不进去", () => {
    const withUnaddressable = [...fields, { label: "无签名字段", kind: "custom" } as any];
    expect(fillableFields(withUnaddressable).map((f) => f.label)).toEqual(["姓名", "邮箱", "学历"]);
    expect(buildAutofillPrompt({ fields: withUnaddressable, profileText, ctx: {} })).not.toContain("无签名字段");
  });

  it("prompt 带上岗位上下文和档案原文", () => {
    const prompt = buildAutofillPrompt({ fields, profileText, ctx: { company: "58同城", title: "产品经理" } });
    expect(prompt).toContain("58同城");
    expect(prompt).toContain("邓雨蝶");
  });
});

describe("validateAutofillPlan", () => {
  it("来源能在档案原文里找到就放行", () => {
    const { values, rejected } = plan([
      { signature: fields[1].signature, value: "yudieden@usc.edu", source: "邮箱：yudieden@usc.edu" },
    ]);
    expect(values).toEqual([{ signature: fields[1].signature, value: "yudieden@usc.edu" }]);
    expect(rejected).toEqual([]);
  });

  it("来源在档案里查无实据就拒绝——这是反编造的执行点，不是 prompt 里的一句话", () => {
    const { values, rejected } = plan([
      { signature: fields[1].signature, value: "fake@example.com", source: "邮箱：fake@example.com" },
    ]);
    expect(values).toEqual([]);
    expect(rejected[0]).toMatchObject({ reason: "unsourced" });
  });

  it("下拉框的值必须命中给定选项——模型自由发挥的值填不进去", () => {
    const ok = plan([{ signature: fields[2].signature, value: "硕士", source: "学历：南加州大学 传播数据科学 硕士" }]);
    expect(ok.values).toHaveLength(1);

    const bad = plan([{ signature: fields[2].signature, value: "研究生", source: "学历：南加州大学 传播数据科学 硕士" }]);
    expect(bad.values).toEqual([]);
    expect(bad.rejected[0]).toMatchObject({ reason: "option_not_allowed" });
  });

  it("签名不在字段表里就拒绝——模型不能凭空指一个框", () => {
    const { rejected } = plan([{ signature: "name=|id=zzz|type=text|label=编造", value: "x", source: "姓名：邓雨蝶" }]);
    expect(rejected[0]).toMatchObject({ reason: "unknown_signature" });
  });

  it("命中安全闸字段一律拒绝，即便模型给了合法来源", () => {
    for (const f of [fields[3], fields[4], fields[5]]) {
      const { values, rejected } = plan([{ signature: f.signature, value: "男", source: "姓名：邓雨蝶" }]);
      expect(values).toEqual([]);
      expect(rejected[0]).toMatchObject({ reason: "gated_field" });
    }
  });

  it("空值、非字符串一律拒绝——空着好过填错", () => {
    for (const value of ["", "   ", 42, null, undefined]) {
      const { rejected } = plan([{ signature: fields[1].signature, value, source: "邮箱：yudieden@usc.edu" }]);
      expect(rejected[0]).toMatchObject({ reason: "empty_value" });
    }
  });

  it("同一个签名给两次，只认第一次", () => {
    const { values, rejected } = plan([
      { signature: fields[1].signature, value: "yudieden@usc.edu", source: "邮箱：yudieden@usc.edu" },
      { signature: fields[1].signature, value: "yudieden@usc.edu", source: "邮箱：yudieden@usc.edu" },
    ]);
    expect(values).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: "duplicate" });
  });

  it("来源比对忽略空白差异，但不做模糊匹配", () => {
    const ok = plan([{ signature: fields[0].signature, value: "雨蝶", source: "姓名：  邓雨蝶" }]);
    expect(ok.values).toHaveLength(1);
  });

  it("太短的来源不算来源——两三个字随便都能在档案里撞上", () => {
    const { rejected } = plan([{ signature: fields[1].signature, value: "yudieden@usc.edu", source: "邮" }]);
    expect(rejected[0]).toMatchObject({ reason: "unsourced" });
  });

  it("模型返回的不是数组时返回空计划而不是抛错", () => {
    expect(validateAutofillPlan(null as any, fields, profileText)).toEqual({ values: [], rejected: [] });
    expect(validateAutofillPlan("oops" as any, fields, profileText)).toEqual({ values: [], rejected: [] });
  });

  it("档案为空时全部拒绝——没有档案就没有任何值有来源", () => {
    const { values } = validateAutofillPlan(
      [{ signature: fields[1].signature, value: "yudieden@usc.edu", source: "邮箱：yudieden@usc.edu" }],
      fields,
      ""
    );
    expect(values).toEqual([]);
  });
});

/**
 * 真机踩到：SOURCE_MIN_LENGTH = 4 让 3 个字的中文姓名永远过不了 source 校验。
 * 用真实简历跑，「邓雨蝶」被判 unsourced——最基本的字段填不上。
 *
 * 长度是个糟糕的代理指标：4 个拉丁字母几乎不携带信息，3 个汉字的姓名却高度
 * 特异。真正要的保证是「引用得包含要填的值」——指给我看这个值出自哪里。
 */
describe("source 校验：以「引用包含值」代替长度阈值", () => {
  const field = (over: any = {}) => ({
    signature: "sig-1", label: "姓名", kind: "custom", type: "text", required: true, options: [], ...over,
  });

  it("3 个字的中文姓名能通过", () => {
    const profile = "邓雨蝶\n手机：15996610829";
    const plan = validateAutofillPlan(
      [{ signature: "sig-1", value: "邓雨蝶", source: "邓雨蝶" }],
      [field()], profile
    );
    expect(plan.values).toEqual([{ signature: "sig-1", value: "邓雨蝶" }]);
  });

  it("引用在档案里但不包含要填的值时拦下——那不叫有出处", () => {
    const profile = "清华大学 数据传播双硕士项目";
    const plan = validateAutofillPlan(
      [{ signature: "sig-1", value: "北京大学", source: "清华大学" }],
      [field()], profile
    );
    expect(plan.values).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ reason: "unsourced" });
  });

  it("有 options 的字段例外：值来自表单选项，引用只需证明依据在档案里", () => {
    const profile = "清华大学 数据传播双硕士项目";
    const plan = validateAutofillPlan(
      [{ signature: "sig-1", value: "研究生", source: "数据传播双硕士项目" }],
      [field({ options: ["本科", "研究生"] })], profile
    );
    expect(plan.values).toEqual([{ signature: "sig-1", value: "研究生" }]);
  });

  it("引用压根不在档案里，一律拦下", () => {
    const plan = validateAutofillPlan(
      [{ signature: "sig-1", value: "邓雨蝶", source: "邓雨蝶" }],
      [field()], "另一个人的简历"
    );
    expect(plan.rejected[0]).toMatchObject({ reason: "unsourced" });
  });

  it("单字符引用仍然拦下，避免退化匹配", () => {
    const plan = validateAutofillPlan(
      [{ signature: "sig-1", value: "邓", source: "邓" }],
      [field()], "邓雨蝶"
    );
    expect(plan.rejected[0]).toMatchObject({ reason: "unsourced" });
  });
});

/**
 * 真机：帆软那页 39 个字段里 16 个「没有标签」——启发式没猜出来，模型于是根本
 * 看不到这些框，30/39 填不上。快照给的是控件周围的**原文**，不是猜出来的标签：
 * 模型看得懂「* 姓名」这种排布，不需要我们先猜对。
 */
describe("prompt 用快照的原文，而不是猜出来的标签", () => {
  const control = (over: any = {}) => ({
    handle: `h-${over.context ?? "x"}`, type: "text", required: true, context: "字段", options: [], ...over,
  });

  it("把 context 原文交给模型，即使没有 label", () => {
    const prompt = buildAutofillPrompt({
      controls: [control({ context: "* 姓名", handle: "h1" })],
      profileText: "姓名：邓雨蝶",
    } as any);
    expect(prompt).toContain("* 姓名");
    expect(prompt).toContain("h1");
  });

  it("文件框不进 prompt——那是安全闸，代码把关", () => {
    const prompt = buildAutofillPrompt({
      controls: [control({ context: "简历附件", type: "file", handle: "hf" })],
      profileText: "简历",
    } as any);
    expect(prompt).not.toContain("hf");
  });

  it("有选项的控件把选项一并给出", () => {
    const prompt = buildAutofillPrompt({
      controls: [control({ context: "学历", handle: "hx", type: "widget", options: ["本科", "研究生"] })],
      profileText: "硕士",
    } as any);
    expect(prompt).toContain("研究生");
  });

  it("没有 context 的控件不进 prompt——模型无从判断，给了也是瞎猜", () => {
    const prompt = buildAutofillPrompt({
      controls: [control({ context: "", handle: "hempty" })],
      profileText: "x",
    } as any);
    expect(prompt).not.toContain("hempty");
  });

  it("仍然兼容旧的 fields 入参，迁移期两条路都能走", () => {
    const prompt = buildAutofillPrompt({
      fields: [{ signature: "s1", label: "姓名", kind: "full_name", type: "text", required: true, options: [] }],
      profileText: "姓名：邓雨蝶",
    } as any);
    expect(prompt).toContain("s1");
  });
});

describe("validateAutofillPlan 接受快照控件", () => {
  const control = (over: any = {}) => ({ handle: "h1", type: "text", required: true, context: "姓名", options: [], ...over });

  it("按句柄校验并通过", () => {
    const plan = validateAutofillPlan(
      [{ signature: "h1", value: "邓雨蝶", source: "邓雨蝶" }],
      [control()] as any, "邓雨蝶 手机：15996610829"
    );
    expect(plan.values).toEqual([{ signature: "h1", value: "邓雨蝶" }]);
  });

  it("文件框的句柄一律拒绝——安全闸不交给模型", () => {
    const plan = validateAutofillPlan(
      [{ signature: "hf", value: "x.pdf", source: "简历附件" }],
      [control({ handle: "hf", type: "file", context: "简历附件" })] as any, "简历附件"
    );
    expect(plan.values).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ reason: "gated_field" });
  });
});


/**
 * 档案是 markdown，引用比对不能被格式噪声挡住。
 *
 * 真机：档案里写的是 `- **姓名**: 邓雨蝶`，模型引「姓名: 邓雨蝶」，去掉空白后是
 * 「姓名:邓雨蝶」，原文却是「姓名**:邓雨蝶」——对不上，判 unsourced。最基本的
 * 字段被自己的闸门挡了。
 *
 * 归一化掉强调符号不削弱反编造：值本身仍然必须在原文里出现，只是不再要求模型
 * 连 markdown 标记一起原样抄。
 */
describe("markdown 强调符号不该挡住引用", () => {
  const profile = "# 邓雨蝶 - 简历 Master\n\n- **姓名**: 邓雨蝶\n- **邮箱**: a@b.com";
  const fields = [{ signature: "sig-name", label: "姓名", kind: "custom", type: "text" }];

  it("引用跨越 ** 时仍然成立", () => {
    const plan = validateAutofillPlan(
      [{ signature: "sig-name", value: "邓雨蝶", source: "姓名: 邓雨蝶" }],
      fields,
      profile
    );
    expect(plan.rejected).toEqual([]);
    expect(plan.values).toEqual([{ signature: "sig-name", value: "邓雨蝶" }]);
  });

  it("编造的值仍然拦得住——归一化不是放水", () => {
    const plan = validateAutofillPlan(
      [{ signature: "sig-name", value: "张三", source: "姓名: 张三" }],
      fields,
      profile
    );
    expect(plan.values).toEqual([]);
    expect(plan.rejected[0].reason).toBe("unsourced");
  });
});
