import { describe, it, expect } from "vitest";
import { buildFileInjections } from "./agent-context.ts";

const reader = (files: Record<string, string>) => (relPath: string) =>
  relPath in files ? files[relPath] : null;

describe("buildFileInjections", () => {
  it("把文件内容包成带标签的段落", () => {
    const out = buildFileInjections(
      [{ path: "profile.md", label: "用户档案" }],
      reader({ "profile.md": "目标岗位：AI 产品经理" })
    );
    expect(out).toEqual(["【用户档案】\n目标岗位：AI 产品经理"]);
  });

  it("指定 lines 时只取末尾 N 行", () => {
    const out = buildFileInjections(
      [{ path: "chat_log.md", label: "团队最近动态", lines: 2 }],
      reader({ "chat_log.md": "第一条\n第二条\n第三条\n第四条" })
    );
    expect(out).toEqual(["【团队最近动态】\n第三条\n第四条"]);
  });

  it("文件行数少于 lines 时全部返回", () => {
    const out = buildFileInjections(
      [{ path: "chat_log.md", label: "团队最近动态", lines: 10 }],
      reader({ "chat_log.md": "只有一条" })
    );
    expect(out).toEqual(["【团队最近动态】\n只有一条"]);
  });

  it("文件不存在时跳过而不是抛错", () => {
    const out = buildFileInjections(
      [{ path: "missing.md", label: "不存在" }],
      reader({})
    );
    expect(out).toEqual([]);
  });

  it("内容只有空白时跳过", () => {
    const out = buildFileInjections(
      [{ path: "empty.md", label: "空的" }],
      reader({ "empty.md": "   \n\n  " })
    );
    expect(out).toEqual([]);
  });

  it("按配置顺序返回多个文件", () => {
    const out = buildFileInjections(
      [
        { path: "a.md", label: "A" },
        { path: "gone.md", label: "没了" },
        { path: "b.md", label: "B" },
      ],
      reader({ "a.md": "内容A", "b.md": "内容B" })
    );
    expect(out).toEqual(["【A】\n内容A", "【B】\n内容B"]);
  });

  it("没有 files 配置时返回空数组", () => {
    expect(buildFileInjections(undefined, reader({}))).toEqual([]);
  });
});
