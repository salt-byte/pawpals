import { describe, it, expect } from "vitest";
import { widgetsToProbe, mergeProbedOptions, retryTargets, fieldsForModel, manualFields } from "./apply-orchestrator.ts";

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

