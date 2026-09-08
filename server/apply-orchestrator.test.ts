import { describe, it, expect } from "vitest";
import { widgetsToProbe, mergeProbedOptions, retryTargets, fieldsForModel, manualFields, shouldRunAnotherRound, stillOpen, questionsForUser, unprobed } from "./apply-orchestrator.ts";

const field = (over: any = {}) => ({
  signature: `sig-${over.label ?? "x"}`, label: "字段", kind: "custom",
  type: "text", required: true, options: [], ...over,
});

/**
 * 真机教训：只探了前 8 个 widget，学历和学位不在其中，模型于是在「不知道有哪些
 * 选项」的情况下把两个都答成「硕士」——概念上没错（硕士就是研究生），但两个
 * 选项列表里都没有这个词，执行时被拒。
 *
 * 根因不是模型的知识，是问的顺序：该填的控件必须先把选项拿到手，再问模型。
 */
describe("widgetsToProbe", () => {
  it("所有有标签、且还不知道选项的 widget 都要探——不是只探一部分", () => {
    const fields = [
      field({ label: "学历", type: "widget" }),
      field({ label: "学位", type: "widget" }),
      field({ label: "性别", type: "widget" }),
    ];
    expect(widgetsToProbe(fields)).toEqual(["sig-学历", "sig-学位", "sig-性别"]);
  });

  it("已经知道选项的不重复探——原生 select 的选项 inspect 就带回来了", () => {
    const fields = [
      field({ label: "学历", type: "widget" }),
      field({ label: "省份", type: "select", options: ["北京", "上海"] }),
    ];
    expect(widgetsToProbe(fields)).toEqual(["sig-学历"]);
  });

  it("原生文本框不需要探", () => {
    expect(widgetsToProbe([field({ label: "姓名", type: "text" })])).toEqual([]);
  });

  it("没有标签的容器不探——那多半不是真字段", () => {
    expect(widgetsToProbe([field({ label: "", type: "widget" })])).toEqual([]);
  });

  it("被闸门挡住的字段不探——性别属于敏感问题，本来就不该由模型填", () => {
    const fields = [field({ label: "性别", type: "widget", kind: "sensitive_demographic" })];
    expect(widgetsToProbe(fields)).toEqual([]);
  });
});

describe("mergeProbedOptions", () => {
  it("把探到的选项并回字段表，供模型作答时使用", () => {
    const fields = [field({ label: "学历", type: "widget" })];
    const merged = mergeProbedOptions(fields, [{ signature: "sig-学历", label: "学历", options: ["本科", "研究生"] }]);
    expect(merged[0].options).toEqual(["本科", "研究生"]);
  });

  it("没探到选项的字段保持原样，不编造空列表以外的东西", () => {
    const fields = [field({ label: "籍贯", type: "widget" })];
    expect(mergeProbedOptions(fields, [{ signature: "sig-籍贯", label: "籍贯", options: [] }])[0].options).toEqual([]);
  });

  it("探测结果里多出来的签名忽略掉", () => {
    const fields = [field({ label: "学历", type: "widget" })];
    const merged = mergeProbedOptions(fields, [{ signature: "sig-不存在", label: "?", options: ["x"] }]);
    expect(merged[0].options).toEqual([]);
  });
});

describe("retryTargets", () => {
  it("option_not_found 且带回了真实选项时，用这些选项重问模型", () => {
    const fields = [field({ label: "学历", type: "widget" })];
    const targets = retryTargets(
      [{ signature: "sig-学历", reason: "option_not_found", options: ["本科", "研究生"] }],
      fields
    );
    expect(targets).toEqual([{ ...fields[0], options: ["本科", "研究生"] }]);
  });

  it("没带回选项的失败不重试——重问也还是瞎猜", () => {
    const fields = [field({ label: "学历", type: "widget" })];
    expect(retryTargets([{ signature: "sig-学历", reason: "panel_did_not_open" }], fields)).toEqual([]);
  });

  it("其他失败原因不重试——签名定位不到，换个值也定位不到", () => {
    const fields = [field({ label: "学历", type: "widget" })];
    expect(retryTargets([{ signature: "sig-学历", reason: "not_found", options: ["本科"] }], fields)).toEqual([]);
  });

  it("字段表里已经没有的签名忽略", () => {
    expect(retryTargets([{ signature: "sig-没了", reason: "option_not_found", options: ["a"] }], [])).toEqual([]);
  });
});

describe("超长选项字段不进模型", () => {
  it("选项被截断的字段照样问模型，只是去掉 options 改走搜索", () => {
    const fields = [
      field({ label: "学历", type: "widget", options: ["本科", "研究生"] }),
      field({ label: "本科学校", type: "widget", options: ["清华大学"], truncated: true }),
    ];
    const asked = fieldsForModel(fields);
    expect(asked.map((f: any) => f.label)).toEqual(["学历", "本科学校"]);
    // options 必须去掉：留着截断后的列表，会让「值必须命中 options」把正确答案判成越界
    expect(asked[1].options).toBeUndefined();
    expect((asked[1] as any).searchable).toBe(true);
  });

  it("没截断的字段原样透传", () => {
    const fields = [field({ label: "学历", type: "widget", options: ["本科", "研究生"] })];
    expect(fieldsForModel(fields)[0]).toEqual(fields[0]);
  });

  it("探不到选项、又不能搜的控件才算要用户自己来", () => {
    const fields = [
      field({ label: "本科学校", type: "widget", options: ["清华大学"], truncated: true }),
      field({ label: "意向团队", type: "widget", options: [] }),
      field({ label: "学历", type: "widget", options: ["本科"] }),
    ];
    expect(manualFields(fields).map((f: any) => f.label)).toEqual(["意向团队"]);
  });
});


/**
 * 分轮填写。
 *
 * 级联下拉（帆软的「意向岗位」依赖「意向岗位大类」）不该靠手写规则识别。页面
 * 自己就写着「请先选择【意向岗位大类】，再选择具体岗位~」，这句话本来就在快照
 * 的 context 里，模型看得见——缺的只是「做一步、再看一眼页面」的机会。
 *
 * 所以改成分轮：填完重新采一次页面，新出现的字段和新解锁的选项进入下一轮。
 * 级联因此自然解决，而且不需要任何关于级联的代码——换一家表单、换一种依赖
 * 关系同样有效。
 */
describe("shouldRunAnotherRound", () => {
  it("这一轮填进去了东西，就再看一眼页面", () => {
    expect(shouldRunAnotherRound({ round: 1, filledThisRound: 3, maxRounds: 4 })).toBe(true);
  });

  it("一个都没填进去就停——页面不会因为再问一遍而变化", () => {
    expect(shouldRunAnotherRound({ round: 1, filledThisRound: 0, maxRounds: 4 })).toBe(false);
  });

  it("到了轮数上限就停，别在页面上无限循环", () => {
    expect(shouldRunAnotherRound({ round: 4, filledThisRound: 5, maxRounds: 4 })).toBe(false);
  });
});

describe("stillOpen", () => {
  const f = (over: any) => ({ signature: `s-${over.label}`, type: "text", ...over });

  it("已经填过的字段不再进下一轮", () => {
    const fields = [f({ label: "姓名" }), f({ label: "手机" })];
    expect(stillOpen(fields, ["s-姓名"]).map((x: any) => x.label)).toEqual(["手机"]);
  });

  it("安全闸字段永远不进——分轮不能成为绕过闸门的路子", () => {
    const fields = [f({ label: "简历", kind: "resume" }), f({ label: "手机" })];
    expect(stillOpen(fields, []).map((x: any) => x.label)).toEqual(["手机"]);
  });

  it("上一轮填过的这一轮又出现（页面重渲染换了句柄），按没填算", () => {
    const fields = [f({ label: "意向岗位" })];
    expect(stillOpen(fields, ["s-别的字段"]).map((x: any) => x.label)).toEqual(["意向岗位"]);
  });
});

/**
 * 档案里没有的，要问用户，不能静默留空。
 *
 * 用户的原话：「民族、学号、内推码 —— 没有的要问我」。之前把这些算作「正确留空」
 * 是自作主张：档案里查不到只说明**我们**不知道，不说明用户不知道。必填项尤其
 * 不能沉默——他以为填好了，一提交才被打回。
 */
describe("questionsForUser", () => {
  const f = (over: any) => ({ signature: `s-${over.label}`, label: over.label, type: "text", ...over });

  it("必填、又没填上的，要问", () => {
    const fields = [f({ label: "民族", required: true }), f({ label: "手机", required: true })];
    expect(questionsForUser(fields, ["s-手机"]).map((q) => q.label)).toEqual(["民族"]);
  });

  it("非必填的也问，但排在后面——用户可以跳过", () => {
    const fields = [f({ label: "内推码" }), f({ label: "学号", required: true })];
    expect(questionsForUser(fields, []).map((q) => q.label)).toEqual(["学号", "内推码"]);
    expect(questionsForUser(fields, [])[1].required).toBe(false);
  });

  it("安全闸字段不问——那不是「缺信息」，是必须用户自己动手", () => {
    const fields = [f({ label: "简历", kind: "resume", required: true }), f({ label: "民族", required: true })];
    expect(questionsForUser(fields, []).map((q) => q.label)).toEqual(["民族"]);
  });

  it("没标签的框不问——问「请填写第 17 个框」毫无意义", () => {
    const fields = [f({ label: "", required: true }), f({ label: "民族", required: true })];
    expect(questionsForUser(fields, []).map((q) => q.label)).toEqual(["民族"]);
  });

  it("有选项的字段把选项一并给出，用户直接挑", () => {
    const fields = [f({ label: "是否内推", type: "widget", options: ["是", "否"], required: true })];
    expect(questionsForUser(fields, [])[0].options).toEqual(["是", "否"]);
  });

  it("问题条数有上限——一次性甩几十个问题没人会答", () => {
    const fields = Array.from({ length: 30 }, (_, i) => f({ label: `字段${i}`, required: true }));
    expect(questionsForUser(fields, []).length).toBeLessThanOrEqual(12);
  });
});

/**
 * 断线续填。
 *
 * 记住「填过哪些句柄」是不够的：service worker 一被回收、页面一重渲染，句柄可能
 * 变，记忆也可能整个丢失。唯一可靠的依据是**页面当前值**——重新采一次快照，有值
 * 的就是填好的，剩下的才要处理。这样中途断线、换标签页、甚至换一天接着做都成立。
 */
describe("alreadyFilled", () => {
  const f = (over: any) => ({ signature: `s-${over.label}`, label: over.label, type: "text", ...over });

  it("页面上有值的算已填，不管我们记不记得填过", () => {
    const fields = [f({ label: "姓名", value: "邓雨蝶" }), f({ label: "手机", value: "" })];
    expect(stillOpen(fields, []).map((x: any) => x.label)).toEqual(["手机"]);
  });

  it("记忆和页面冲突时以页面为准——记得填过但页面是空的，要重填", () => {
    const fields = [f({ label: "民族", value: "" })];
    expect(stillOpen(fields, ["s-民族"]).map((x: any) => x.label)).toEqual(["民族"]);
  });

  it("只有空白的值不算填过", () => {
    const fields = [f({ label: "民族", value: "   " })];
    expect(stillOpen(fields, []).map((x: any) => x.label)).toEqual(["民族"]);
  });
});

/**
 * 探测返回 partial 时要补探，不能当成「探完了」。
 *
 * 真机上 partial 很常见（单控件约 2.8 秒，一批的预算有限）。把 partial 当完成，
 * 那些没轮到的控件就永远没有选项，模型永远答不对它们。
 */
describe("unprobed", () => {
  const w = (label: string, options: string[] = []) => ({ signature: `s-${label}`, label, type: "widget", options });

  it("列出这一批里没被探到的", () => {
    const wanted = ["s-A", "s-B", "s-C"];
    const probed = [{ signature: "s-A", options: ["x"] }];
    expect(unprobed(wanted, probed)).toEqual(["s-B", "s-C"]);
  });

  it("探到了但选项是空的，也算探过——那是真没有选项，重探还是空", () => {
    expect(unprobed(["s-A"], [{ signature: "s-A", options: [] }])).toEqual([]);
  });

  it("超时的要补探——那不是「没有选项」，是没读完", () => {
    expect(unprobed(["s-A"], [{ signature: "s-A", options: [], timedOut: true }])).toEqual(["s-A"]);
  });

  it("全探到了返回空", () => {
    expect(unprobed(["s-A"], [{ signature: "s-A", options: ["x"] }])).toEqual([]);
  });
});
